import { and, eq, gte, inArray, lt, or } from 'drizzle-orm'
import { z } from 'zod'
import { SpotifyCodeMatchSchema } from '@repo/schemas/tidal'
import { SpotifyIdSchema } from '@/lib/spotify-api'
import {
  catalogObservation,
  providerResponse,
  spotifyCodeLookup,
} from '@/schemas/db'
import type { ChangeTransaction } from './library-change-effect'

const ObjectSchema = z.record(z.string(), z.unknown())
const ArraySchema = z.array(z.unknown())
const RecordingSchema = z.object({
  id: SpotifyIdSchema,
  artists: z.array(z.unknown()).max(50),
  type: z.literal('track').optional(),
})
const BillingSchema = z.object({ id: SpotifyIdSchema, name: z.string() })
const PlaylistEntrySchema = z.object({
  item: z.unknown().optional(),
  track: z.unknown().optional(),
  is_local: z.literal(false).optional(),
})

type Reader = Pick<ChangeTransaction, 'select' | 'selectDistinct'>
type Scope = {
  track_id: string
  spotify_id: string
  name: string
  position: number
}

function field(payload: unknown, name: string) {
  return ObjectSchema.safeParse(payload).data?.[name]
}

function list(payload: unknown) {
  return ArraySchema.safeParse(payload).data ?? []
}

function spotifyResponseTracks(url: URL, payload: unknown) {
  const path = url.pathname
  if (path === '/v1/search')
    return list(field(field(payload, 'tracks'), 'items'))
  if (path === '/v1/tracks') return list(field(payload, 'tracks'))
  if (/^\/v1\/tracks\/[A-Za-z0-9]{22}$/.test(path))
    return field(payload, 'id') === path.slice('/v1/tracks/'.length)
      ? [payload]
      : []
  if (/^\/v1\/albums\/[A-Za-z0-9]{22}$/.test(path))
    return field(payload, 'id') === path.slice('/v1/albums/'.length)
      ? list(field(field(payload, 'tracks'), 'items'))
      : []
  if (/^\/v1\/albums\/[A-Za-z0-9]{22}\/tracks$/.test(path))
    return list(field(payload, 'items'))
  const entries =
    path === '/v1/me/tracks' ||
    /^\/v1\/playlists\/[A-Za-z0-9]{22}\/(items|tracks)$/.test(path)
      ? list(field(payload, 'items'))
      : /^\/v1\/playlists\/[A-Za-z0-9]{22}$/.test(path)
        ? list(
            field(field(payload, 'items') ?? field(payload, 'tracks'), 'items'),
          )
        : []
  return entries.flatMap((raw) => {
    const entry = PlaylistEntrySchema.safeParse(raw).data
    return entry ? [entry.item ?? entry.track] : []
  })
}

function readSpotifyResponse(
  row: Pick<typeof providerResponse.$inferSelect, 'requestUrl' | 'body'>,
) {
  if (!row.requestUrl || row.body.state !== 'captured') return []
  try {
    const url = new URL(row.requestUrl)
    if (
      url.origin !== 'https://api.spotify.com' ||
      url.username ||
      url.password
    )
      return []
    const payload: unknown = JSON.parse(row.body.text)
    return spotifyResponseTracks(url, payload).flatMap((raw) => {
      const track = RecordingSchema.safeParse(raw).data
      return track ? [track] : []
    })
  } catch {
    return []
  }
}

export async function scopedSpotifyRetainedBilling(
  tx: Reader,
  scopes: Scope[],
) {
  if (!scopes.length) return () => []
  const localIds = [...new Set(scopes.map(({ track_id }) => track_id))]
  const spotifyIds = [...new Set(scopes.map(({ spotify_id }) => spotify_id))]
  const [lookups, responseLinks] = await Promise.all([
    tx
      .select({
        id: spotifyCodeLookup.spotifyId,
        result: spotifyCodeLookup.result,
      })
      .from(spotifyCodeLookup)
      .where(
        and(
          eq(spotifyCodeLookup.source, 'spotify'),
          eq(spotifyCodeLookup.codeType, 'isrc'),
          inArray(spotifyCodeLookup.spotifyId, spotifyIds),
        ),
      ),
    tx
      .selectDistinct({
        id: providerResponse.id,
        targetKind: catalogObservation.targetKind,
        targetId: catalogObservation.targetId,
        subjectKind: catalogObservation.subjectKind,
        subjectId: catalogObservation.subjectId,
      })
      .from(catalogObservation)
      .innerJoin(
        providerResponse,
        eq(providerResponse.id, catalogObservation.responseId),
      )
      .where(
        and(
          eq(catalogObservation.provider, 'spotify'),
          eq(providerResponse.provider, 'spotify'),
          eq(providerResponse.method, 'GET'),
          eq(providerResponse.bodyState, 'captured'),
          gte(providerResponse.status, 200),
          lt(providerResponse.status, 300),
          or(
            and(
              eq(catalogObservation.targetKind, 'track'),
              inArray(catalogObservation.targetId, localIds),
            ),
            and(
              eq(catalogObservation.subjectKind, 'track'),
              inArray(catalogObservation.subjectId, localIds),
            ),
          ),
        ),
      ),
  ])
  const billingByRecording = new Map<string, unknown[][]>()
  for (const { id, result } of lookups) {
    const match = SpotifyCodeMatchSchema.safeParse(result).data
    if (!id || match?.spotifyId !== id || !match.artistCredits) continue
    // The legacy compact ID list does not preserve slots if some credits lacked IDs.
    if (
      match.artistCredits.length !== match.artists.length ||
      match.artistCredits.some(
        ({ name }, index) => name !== match.artists[index],
      )
    )
      continue
    const stored = billingByRecording.get(id) ?? []
    stored.push(match.artistCredits)
    billingByRecording.set(id, stored)
  }
  const responseIds = [...new Set(responseLinks.map(({ id }) => id))]
  const responses = new Map<string, ReturnType<typeof readSpotifyResponse>>()
  const candidateIds = new Set(spotifyIds)
  for (let start = 0; start < responseIds.length; start += 20) {
    const receipts = await tx
      .select({
        id: providerResponse.id,
        requestUrl: providerResponse.requestUrl,
        body: providerResponse.body,
      })
      .from(providerResponse)
      .where(inArray(providerResponse.id, responseIds.slice(start, start + 20)))
    for (const receipt of receipts)
      responses.set(
        receipt.id,
        readSpotifyResponse(receipt).filter(({ id }) => candidateIds.has(id)),
      )
  }
  const linkedIds = new Map<string, Set<string>>()
  const allowed = new Set(localIds)
  for (const link of responseLinks) {
    const tracks = [
      link.targetKind === 'track' ? link.targetId : null,
      link.subjectKind === 'track' ? link.subjectId : null,
    ]
    for (const id of tracks) {
      if (!id || !allowed.has(id)) continue
      const ids = linkedIds.get(id) ?? new Set<string>()
      ids.add(link.id)
      linkedIds.set(id, ids)
    }
  }

  return ({ track_id, spotify_id, name, position }: Scope) => {
    const bills = [...(billingByRecording.get(spotify_id) ?? [])]
    for (const id of linkedIds.get(track_id) ?? [])
      for (const recording of responses.get(id) ?? [])
        if (recording.id === spotify_id) bills.push(recording.artists)
    return bills.flatMap((bill) => {
      const credit = BillingSchema.safeParse(bill[position - 1]).data
      return credit?.name === name ? [credit.id] : []
    })
  }
}
