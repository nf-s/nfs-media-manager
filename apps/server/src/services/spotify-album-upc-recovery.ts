import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { DIRECT_PROVIDER_RESPONSE_SOURCE } from '@repo/schemas/provider-response'
import type { db } from '@/lib/db'
import { SpotifyIdSchema, UpcSchema } from '@/lib/spotify-api'
import { providerReference } from '@/schemas/db'
import { lockLibraryTrackWrites } from './album-library-tracks'
import {
  resolveCatalogReferences,
  type CatalogMedia,
} from './catalog-discoveries'
import { recordSpotifyCatalogCodes } from './spotify-catalog-codes'

const SpotifyAlbumCode = z.object({
  id: SpotifyIdSchema,
  name: z.string().min(1),
  external_ids: z.object({ upc: UpcSchema }),
})
const AlbumSearchPage = z.object({
  albums: z.object({ items: z.array(z.unknown()).max(50) }),
})
const AlbumEvidence = z.object({
  cursor: z.string(),
  responseId: z.string().nullable(),
  jobId: z.string().nullable(),
  snapshotId: z.string().nullable(),
  importId: z.string().nullable(),
  mediaItemId: z.string().nullable(),
  requestUrl: z.string().nullable(),
  text: z.string().nullable(),
  upc: UpcSchema.nullable(),
})
type Candidate = {
  album: CatalogMedia & { externalId: string }
  upc: string
  evidence: z.infer<typeof AlbumEvidence>
}

function albumCodeCandidates(
  evidence: z.infer<typeof AlbumEvidence>,
): Candidate[] {
  if (!evidence.text || !evidence.requestUrl) return []
  let body: unknown
  try {
    body = JSON.parse(evidence.text)
  } catch {
    return []
  }
  const [url] = evidence.requestUrl.split('?')
  const items =
    url === 'https://api.spotify.com/v1/search'
      ? (AlbumSearchPage.safeParse(body).data?.albums.items ?? [])
      : [body]
  return items.flatMap((entry) => {
    const parsed = SpotifyAlbumCode.safeParse(entry)
    if (!parsed.success) return []
    const { id, name, external_ids } = parsed.data
    if (
      url !== 'https://api.spotify.com/v1/search' &&
      url !== `https://api.spotify.com/v1/albums/${id}`
    )
      return []
    return [
      {
        album: {
          kind: 'album',
          title: name,
          provider: 'spotify',
          referenceType: 'spotify',
          externalId: id,
        },
        upc: external_ids.upc,
        evidence,
      },
    ]
  })
}

/** Reuse retained Spotify evidence without creating or merging catalog records. */
export async function recoverStoredSpotifyAlbumUpcs(
  database: Pick<typeof db, 'transaction' | 'execute'>,
  {
    apply = false,
    limit = 100,
    after,
  }: { apply?: boolean; limit?: number; after?: string } = {},
) {
  const { rows } = await database.execute(sql`
    with retained as (
      select 'response:' || id as cursor, id as "responseId", job_id as "jobId", null::text as "snapshotId",
        null::text as "importId", null::text as "mediaItemId", request_url as "requestUrl", body->>'text' as text, null::text as upc
      from provider_response
      where provider = 'spotify' and method = 'GET' and status between 200 and 299 and body_state = 'captured'
        and request_url ~ '^https://api[.]spotify[.]com/v1/(search([?]|$)|albums/[A-Za-z0-9]{22}([?]|$))'
      union all
      select 'snapshot:' || id, null, null, id, null, null, payload #>> '{request,url}',
        payload #>> '{response,body,text}', null
      from provider_snapshot
      where provider = 'spotify' and source = ${DIRECT_PROVIDER_RESPONSE_SOURCE}
        and payload #>> '{response,status}' ~ '^2[0-9]{2}$'
        and payload #>> '{response,body,state}' = 'captured'
        and payload #>> '{request,url}' ~ '^https://api[.]spotify[.]com/v1/albums/[A-Za-z0-9]{22}([?]|$)'
      union all
      select 'preview:' || id, null, null, null, import_id, media_item_id, null, null, details->>'upc'
      from catalog_observation
      where provider = 'spotify' and operation = 'album-import-preview' and relationship_role = 'preview_album'
        and target_kind = 'album' and import_id is not null and media_item_id is not null
        and details->>'upc' ~ '^[0-9]{8,14}$'
    )
    select * from retained
    ${after ? sql`where cursor > ${after}` : sql``}
    order by cursor limit ${limit}
  `)
  const evidence = AlbumEvidence.array().parse(rows)
  return database.transaction(async (tx) => {
    if (apply) await lockLibraryTrackWrites(tx)
    const candidates = evidence.flatMap(albumCodeCandidates)
    const previews = evidence.flatMap((row) =>
      row.mediaItemId ? [row.mediaItemId] : [],
    )
    const refs = previews.length
      ? await tx
          .select({
            id: providerReference.mediaItemId,
            externalId: providerReference.externalId,
          })
          .from(providerReference)
          .where(
            and(
              inArray(providerReference.mediaItemId, previews),
              eq(providerReference.provider, 'spotify'),
              inArray(providerReference.referenceType, [
                'album',
                'spotify',
                'spotify_album',
              ]),
            ),
          )
      : []
    const native = new Map<string, Set<string>>()
    for (const { id, externalId } of refs) {
      const ids = native.get(id) ?? new Set<string>()
      if (SpotifyIdSchema.safeParse(externalId).success) ids.add(externalId)
      native.set(id, ids)
    }
    for (const row of evidence) {
      if (!row.mediaItemId || !row.upc) continue
      const ids = native.get(row.mediaItemId)
      const externalId = ids?.size === 1 ? ids.values().next().value : undefined
      if (externalId)
        candidates.push({
          album: {
            kind: 'album',
            title: 'Spotify album',
            provider: 'spotify',
            referenceType: 'spotify',
            externalId,
          },
          upc: row.upc,
          evidence: row,
        })
    }
    const matches = await resolveCatalogReferences(
      tx,
      candidates.map(({ album }) => album),
    )
    const codes = new Map<
      string,
      Parameters<typeof recordSpotifyCatalogCodes>[1][number]
    >()
    for (const { album, upc, evidence } of candidates) {
      const references = matches.get(album.externalId)?.references
      const mediaItemId =
        references?.size === 1 ? references.values().next().value : undefined
      if (
        !mediaItemId ||
        (evidence.mediaItemId && evidence.mediaItemId !== mediaItemId)
      )
        continue
      const key = JSON.stringify([mediaItemId, upc])
      if (/^0+$/.test(upc) || codes.has(key)) continue
      codes.set(key, {
        mediaItemId,
        kind: 'album',
        value: upc,
        origin: {
          operation: 'spotify-upc-recovery',
          ...(evidence.jobId ? { jobId: evidence.jobId } : {}),
          ...(evidence.responseId ? { responseId: evidence.responseId } : {}),
          ...(evidence.snapshotId ? { snapshotId: evidence.snapshotId } : {}),
          ...(evidence.importId ? { importId: evidence.importId } : {}),
        },
      })
    }
    const saved = codes.size
      ? await tx
          .select({
            id: providerReference.mediaItemId,
            upc: providerReference.externalId,
          })
          .from(providerReference)
          .where(
            and(
              inArray(providerReference.mediaItemId, [
                ...new Set(
                  [...codes.values()].map(({ mediaItemId }) => mediaItemId),
                ),
              ]),
              eq(providerReference.provider, 'spotify'),
              eq(providerReference.referenceType, 'upc'),
            ),
          )
      : []
    for (const { id, upc } of saved) codes.delete(JSON.stringify([id, upc]))
    return {
      inspected: evidence.length,
      candidates: candidates.length,
      pendingReferences: codes.size,
      references: apply
        ? await recordSpotifyCatalogCodes(tx, [...codes.values()])
        : 0,
      next: evidence.at(-1)?.cursor ?? null,
    }
  })
}
