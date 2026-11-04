import { and, asc, desc, eq, gt, inArray, notInArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { checksumJson, createStableId } from '@/lib/media-utils'
import { AlbumRymUrlSchema } from '@/plugins/builtin/album-provider-helpers'
import { extractSerplyAlbumTags } from '@/plugins/builtin/serply'
import {
  mediaItem,
  mediaItemTag,
  providerCurrentState,
  providerReference,
  providerReferenceOverride,
  providerSnapshot,
  scrapeJob,
  tag,
  tagIdentity,
  tagOccurrence,
} from '@/schemas/db'
import {
  lockTagWrites,
  normalizeTagName,
  tagDisplayName,
  type TagDatabase,
} from './tag-state'

const provider = 'serply'
const source = 'rym'
const mediaType = 'album'
const normalizedSchema = z.object({
  references: z.array(
    z.object({ referenceType: z.string(), externalId: z.string() }),
  ),
  mediaPatch: z.object({
    metadata: z.object({
      'plugin.serply.provenance': z.object({
        source: z.literal(source),
        retrievalProvider: z.literal(provider),
        sourceUrl: z.string(),
        releaseUrl: z.string().min(1).optional(),
        releaseKind: z.string().nullish(),
        matchStatus: z
          .enum(['rated', 'genres-only', 'identity-only'])
          .optional(),
      }),
    }),
  }),
})

// Only normalize transport, host and release child navigation. Never discard
// numeric edition slugs or .p when comparing observed URLs to active references.
function releasePath(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  url.pathname = url.pathname.replace(
    /^(\/release\/[^/]+\/[^/]+\/[^/]+)\/(?:reviews|lists)(?:\/\d+)?\/?$/,
    '$1/',
  )
  if (
    !AlbumRymUrlSchema.safeParse(url.href).success ||
    !/^(?:\/release\/(?:album|ep|comp|mixtape|single|djmix)\/|\/music-review\/)/.test(
      url.pathname,
    )
  )
    return null
  return url.pathname.replace(/\/$/, '')
}

export function applicableRymSource(
  normalized: unknown,
  references: string[],
  latestOverride?: string,
) {
  const parsed = normalizedSchema.safeParse(normalized)
  if (!parsed.success) return null
  const provenance = parsed.data.mediaPatch.metadata['plugin.serply.provenance']
  const path = releasePath(provenance.sourceUrl)
  const saved = parsed.data.references.filter(
    (r) => r.referenceType === 'rym-url',
  )
  if (
    !path ||
    !saved.length ||
    !references.length ||
    [
      ...saved.map((r) => r.externalId),
      ...references,
      ...(latestOverride !== undefined ? [latestOverride] : []),
    ].some((value) => releasePath(value) !== path)
  )
    return null
  // Modern Serply stores releaseUrl without terminal .p for family comparison.
  // It is corroboration only; never use it to widen the scope of extraction.
  if (provenance.releaseUrl) {
    const family = releasePath(provenance.releaseUrl)
    const [, type, , artist, title] = path.split('/')
    const provenReviewFamily =
      type === 'music-review' &&
      provenance.releaseKind &&
      family ===
        `/release/${provenance.releaseKind}/${artist}/${title?.replace(/\.p$/, '')}`
    if (
      family !== path &&
      family !== path.replace(/\.p$/, '') &&
      !provenReviewFamily
    )
      return null
  }
  return provenance.sourceUrl
}

type Evidence = ReturnType<typeof extractSerplyAlbumTags>[number] & {
  mediaItemId: string
  snapshotId: string
  checksum: string
}
type Addition = Evidence & {
  normalizedName: string
  tagId: string
  occurrenceId: string
  newTag: boolean
  newMembership: boolean
  newOccurrence: boolean
}
type Scope = { target: string; mediaId?: string }

async function savedGenreVocabulary(database: TagDatabase) {
  const vocabulary = new Set<string>()
  const genreArray = z.array(z.string().min(1))
  let cursor: string | undefined
  for (;;) {
    const rows = await database
      .select({
        id: mediaItem.id,
        genres: sql<unknown>`${providerCurrentState.payload}->'rymGoogle'->'genres'`,
      })
      .from(providerCurrentState)
      .innerJoin(mediaItem, eq(mediaItem.id, providerCurrentState.mediaItemId))
      .where(
        and(
          eq(mediaItem.mediaType, mediaType),
          eq(providerCurrentState.provider, 'google-custom-search'),
          cursor ? gt(mediaItem.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(mediaItem.id))
      .limit(500)
    if (!rows.length) return vocabulary
    cursor = rows.at(-1)?.id
    for (const row of rows) {
      const parsed = genreArray.safeParse(row.genres)
      if (parsed.success) for (const name of parsed.data) vocabulary.add(name)
    }
  }
}

export async function previewRymTags(database: TagDatabase, scope: Scope) {
  const vocabulary = await savedGenreVocabulary(database)
  let cursor: string | undefined
  let scanned = 0
  let alreadyPresent = 0
  let duplicateEvidence = 0
  const historical = {
    scanned: 0,
    sameIssue: 0,
    unconfirmed: 0,
    differentOrUnproven: 0,
  }
  const additions: Addition[] = []
  const skipped: { mediaItemId: string; reason: string }[] = []
  const newIdentities = new Map<string, string>()
  for (;;) {
    const rows = await database
      .select({
        mediaItemId: mediaItem.id,
        status: providerCurrentState.status,
        lastSuccess: providerCurrentState.lastSuccessfulAt,
        checksum: providerCurrentState.checksum,
        snapshot: {
          id: providerSnapshot.id,
          checksum: providerSnapshot.checksum,
          source: providerSnapshot.source,
          payload: providerSnapshot.payload,
          normalized: providerSnapshot.normalizedData,
        },
        jobStatus: scrapeJob.status,
      })
      .from(providerCurrentState)
      .innerJoin(mediaItem, eq(mediaItem.id, providerCurrentState.mediaItemId))
      .leftJoin(
        providerSnapshot,
        and(
          eq(providerSnapshot.id, providerCurrentState.latestSnapshotId),
          eq(providerSnapshot.mediaItemId, mediaItem.id),
          eq(providerSnapshot.provider, provider),
        ),
      )
      .leftJoin(
        scrapeJob,
        and(
          eq(scrapeJob.id, providerSnapshot.scrapeJobId),
          eq(scrapeJob.provider, provider),
        ),
      )
      .where(
        and(
          eq(providerCurrentState.provider, provider),
          eq(mediaItem.mediaType, mediaType),
          scope.mediaId ? eq(mediaItem.id, scope.mediaId) : undefined,
          cursor ? gt(mediaItem.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(mediaItem.id))
      .limit(50)
    if (!rows.length) break
    scanned += rows.length
    cursor = rows.at(-1)?.mediaItemId
    const ids = rows.map((r) => r.mediaItemId)
    const refRows = await database
      .select({
        mediaItemId: providerReference.mediaItemId,
        externalId: providerReference.externalId,
      })
      .from(providerReference)
      .where(
        and(
          inArray(providerReference.mediaItemId, ids),
          eq(providerReference.provider, provider),
          eq(providerReference.referenceType, 'rym-url'),
        ),
      )
    const overrides = await database
      .selectDistinctOn([providerReferenceOverride.mediaItemId], {
        mediaItemId: providerReferenceOverride.mediaItemId,
        externalId: providerReferenceOverride.externalId,
      })
      .from(providerReferenceOverride)
      .where(
        and(
          inArray(providerReferenceOverride.mediaItemId, ids),
          eq(providerReferenceOverride.provider, provider),
          eq(providerReferenceOverride.referenceType, 'rym-url'),
        ),
      )
      .orderBy(
        asc(providerReferenceOverride.mediaItemId),
        desc(providerReferenceOverride.createdAt),
        desc(providerReferenceOverride.id),
      )
    const evidence: Evidence[] = []
    const anchors = new Map<string, { url: string; snapshotId: string }>()
    const withTags = new Set<string>()
    const collect = (
      mediaItemId: string,
      snapshotId: string,
      checksum: string,
      payload: unknown,
      url: string,
    ) => {
      const extracted = extractSerplyAlbumTags(payload, url, vocabulary)
      if (extracted.length) withTags.add(mediaItemId)
      for (const item of extracted)
        evidence.push({ ...item, mediaItemId, checksum, snapshotId })
    }
    for (const {
      mediaItemId,
      snapshot,
      checksum,
      lastSuccess,
      status,
      jobStatus,
    } of rows) {
      if (
        !snapshot ||
        snapshot.source !== 'scrape-job' ||
        snapshot.checksum !== checksum ||
        status !== 'ready' ||
        !lastSuccess ||
        jobStatus !== 'succeeded'
      ) {
        skipped.push({ mediaItemId, reason: 'no-current-success' })
        continue
      }
      const url = applicableRymSource(
        snapshot.normalized,
        refRows
          .filter((r) => r.mediaItemId === mediaItemId)
          .map((r) => r.externalId),
        overrides.find((r) => r.mediaItemId === mediaItemId)?.externalId,
      )
      if (!url) {
        skipped.push({ mediaItemId, reason: 'unproven-or-changed-reference' })
        continue
      }
      anchors.set(mediaItemId, { url, snapshotId: snapshot.id })
      collect(mediaItemId, snapshot.id, checksum, snapshot.payload, url)
    }
    let after: string | undefined
    while (anchors.size) {
      const history = await database
        .select({
          id: providerSnapshot.id,
          mediaItemId: providerSnapshot.mediaItemId,
          payload: providerSnapshot.payload,
          normalized: providerSnapshot.normalizedData,
          checksum: providerSnapshot.checksum,
          jobStatus: scrapeJob.status,
        })
        .from(providerSnapshot)
        .leftJoin(
          scrapeJob,
          and(
            eq(scrapeJob.id, providerSnapshot.scrapeJobId),
            eq(scrapeJob.provider, provider),
          ),
        )
        .where(
          and(
            eq(providerSnapshot.provider, provider),
            eq(providerSnapshot.source, 'scrape-job'),
            inArray(providerSnapshot.mediaItemId, [...anchors.keys()]),
            notInArray(
              providerSnapshot.id,
              [...anchors.values()].map((r) => r.snapshotId),
            ),
            after ? gt(providerSnapshot.id, after) : undefined,
          ),
        )
        .orderBy(asc(providerSnapshot.id))
        .limit(50)
      if (!history.length) break
      after = history.at(-1)?.id
      for (const old of history) {
        historical.scanned++
        if (old.jobStatus !== 'succeeded') {
          historical.unconfirmed++
          continue
        }
        const anchor = old.mediaItemId && anchors.get(old.mediaItemId)
        const url = anchor && applicableRymSource(old.normalized, [anchor.url])
        if (!url || !old.mediaItemId) {
          historical.differentOrUnproven++
          continue
        }
        historical.sameIssue++
        collect(old.mediaItemId, old.id, old.checksum, old.payload, url)
      }
    }
    for (const mediaItemId of anchors.keys())
      if (!withTags.has(mediaItemId))
        skipped.push({ mediaItemId, reason: 'no-supported-header' })
    if (!evidence.length) continue
    const names = [...new Set(evidence.map((e) => normalizeTagName(e.name)))]
    const identities = await database
      .select()
      .from(tagIdentity)
      .where(
        and(
          eq(tagIdentity.mediaType, mediaType),
          inArray(tagIdentity.normalizedName, names),
        ),
      )
      .orderBy(asc(tagIdentity.tagId))
    const memberships = new Set(
      (
        await database
          .select()
          .from(mediaItemTag)
          .where(inArray(mediaItemTag.mediaItemId, ids))
      ).map((r) => JSON.stringify([r.mediaItemId, r.tagId])),
    )
    const origins = new Set(
      (
        await database
          .select()
          .from(tagOccurrence)
          .where(
            and(
              inArray(tagOccurrence.mediaItemId, ids),
              eq(tagOccurrence.provider, provider),
              eq(tagOccurrence.source, source),
            ),
          )
      ).map((r) =>
        JSON.stringify([
          r.mediaItemId,
          r.tagId,
          r.kind,
          normalizeTagName(r.rawName),
        ]),
      ),
    )
    const seen = new Set<string>()
    for (const e of evidence) {
      const normalizedName = normalizeTagName(e.name)
      if (!normalizedName) continue
      // Same selection order and stable IDs as upsertProviderTags, but plan
      // insert-only batches; its ordinary conflict update touches timestamps.
      const matches = identities.filter(
        (r) => r.normalizedName === normalizedName,
      )
      const existingId =
        (matches.find((r) => r.kind === e.kind) ?? matches[0])?.tagId ??
        newIdentities.get(normalizedName)
      const tagId =
        existingId ??
        createStableId('tag', `${mediaType}:${e.kind}:${normalizedName}`)
      if (!existingId) newIdentities.set(normalizedName, tagId)
      const memberKey = JSON.stringify([e.mediaItemId, tagId])
      const originKey = JSON.stringify([
        e.mediaItemId,
        tagId,
        e.kind,
        normalizeTagName(e.rawName),
      ])
      if (seen.has(originKey)) {
        duplicateEvidence++
        continue
      }
      seen.add(originKey)
      const newMembership = !memberships.has(memberKey)
      const newOccurrence = !origins.has(originKey)
      if (!newMembership && !newOccurrence) {
        alreadyPresent++
        continue
      }
      memberships.add(memberKey)
      origins.add(originKey)
      const occurrenceId = createStableId(
        'tagocc',
        JSON.stringify([
          e.mediaItemId,
          provider,
          source,
          null,
          e.rawName,
          e.kind,
          normalizedName,
        ]),
      )
      additions.push({
        ...e,
        normalizedName,
        tagId,
        occurrenceId,
        newTag: !existingId,
        newMembership,
        newOccurrence,
      })
    }
  }
  const plan = {
    scope,
    scanned,
    historical,
    skipped,
    alreadyPresent,
    duplicateEvidence,
    additions,
  }
  return { ...plan, review: checksumJson(plan) }
}

export async function applyRymTags(
  database: TagDatabase,
  scope: Scope,
  review: string,
) {
  await lockTagWrites(database)
  const plan = await previewRymTags(database, scope)
  if (plan.review !== review)
    throw new Error('Dry-run evidence changed; review a fresh preview.')
  for (let start = 0; start < plan.additions.length; start += 250) {
    const batch = plan.additions.slice(start, start + 250)
    const ids = [...new Set(batch.map((r) => r.mediaItemId))]
    // Reference overrides and successful scrapes both acquire this media row
    // before changing identity. Fail on concurrent changes, never retry.
    await database
      .select({ id: mediaItem.id })
      .from(mediaItem)
      .where(inArray(mediaItem.id, ids))
      .orderBy(asc(mediaItem.id))
      .for('share')
    const tags = batch.filter((r) => r.newTag)
    if (tags.length) {
      await database.insert(tag).values(
        tags.map((r): typeof tag.$inferInsert => ({
          id: r.tagId,
          mediaType,
          name: tagDisplayName(r.name),
          kind: r.kind,
        })),
      )
      await database.insert(tagIdentity).values(
        tags.map((r): typeof tagIdentity.$inferInsert => ({
          tagId: r.tagId,
          mediaType,
          normalizedName: r.normalizedName,
          kind: r.kind,
        })),
      )
    }
    const memberships = batch.filter((r) => r.newMembership)
    if (memberships.length)
      await database
        .insert(mediaItemTag)
        .values(
          memberships.map(({ mediaItemId, tagId }) => ({ mediaItemId, tagId })),
        )
    const origins = batch.filter((r) => r.newOccurrence)
    if (origins.length)
      await database.insert(tagOccurrence).values(
        origins.map((r) => ({
          id: r.occurrenceId,
          mediaItemId: r.mediaItemId,
          tagId: r.tagId,
          provider,
          source,
          rawName: r.rawName,
          kind: r.kind,
        })),
      )
  }
  return plan
}
