import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { SonovaultTrackSchema } from '@/lib/sonovault-api'
import {
  sonovaultTagName,
  sonovaultTagNameMap,
  type SonovaultTagKind,
} from '@/lib/sonovault-tags'
import { normalizedTagSql } from '@/lib/tag-sql'
import {
  libraryTrack,
  providerResponse,
  tag,
  tagAlias,
  tagOccurrence,
  trackTag,
} from '@/schemas/db'
import { lockLibraryTrackWrites } from './album-library-tracks'
import {
  lockTrackTagWrites,
  normalizeTagName,
  providerTagOccurrence,
  resolveProviderTagNames,
  upsertTagOccurrences,
  type TagWriter,
} from './tag-state'

const PROVIDER = 'sonovault'
/** Tracks per write statement (TTAG-07). */
const TRACK_BATCH = 500
const RESPONSE_BATCH = 20

/** The fields of a Sonovault track record that hold its tags. */
export type SonovaultTrackTags = { genre: string[]; subgenre: string[] }

export type SonovaultTrackTagsEntry = {
  mediaItemId: string
  /** The track's record; null when Sonovault no longer finds the track. */
  record: SonovaultTrackTags | null
  /** Whether the record agreed with the library track (SONO-08). */
  verified: boolean
  responseId: string | null
  fetchedAt: Date
}

export type TrackTagsWritten = {
  tracks: number
  /** Sonovault rows the records give, and how many of them are verified. */
  rows: number
  verifiedRows: number
  inserted: number
  updated: number
  /** Sonovault rows dropped: deleted, or kept for the owner's mark. */
  cleared: number
  occurrences: number
  /** Sonovault's names (normalised) that had no tag. */
  created: string[]
  /** Sonovault's names (normalised) and the tag each resolves to. */
  names: Map<string, string>
}

type Row = {
  mediaItemId: string
  tagId: string
  verified: boolean
  responseId: string | null
  fetchedAt: Date
}

const ExistingRowsSchema = z.array(
  z.object({
    media_item_id: z.string(),
    tag_id: z.string(),
    sonovault: z.boolean(),
    verified: z.boolean(),
    response_id: z.string().nullable(),
    fetched_at: z.string().nullable(),
    owner: z.string().nullable(),
  }),
)

/** A text array parameter: Drizzle expands a JS array into separate values. */
const textArray = (values: string[]) =>
  sql`array(select jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`

const key = (mediaItemId: string, tagId: string) =>
  `${mediaItemId}\u0000${tagId}`
const pairs = (rows: { mediaItemId: string; tagId: string }[]) =>
  JSON.stringify(
    rows.map((row) => ({ media_item_id: row.mediaItemId, tag_id: row.tagId })),
  )

/**
 * Canonical IDs for resolved tags. A name resolved before a merge committed
 * can name the merged tag; under the shared track tag lock the alias is seen.
 */
async function canonicalTagIds(database: TagWriter, tagIds: string[]) {
  const targets = new Map<string, string>()
  if (!tagIds.length) return targets
  for (const row of await database
    .select({ source: tagAlias.sourceTagId, target: tagAlias.targetTagId })
    .from(tagAlias)
    .where(inArray(tagAlias.sourceTagId, tagIds)))
    targets.set(row.source, row.target)
  return targets
}

/**
 * Replaces the Sonovault side of each entry's track tags with what its
 * record says (TTAG-04, TTAG-08): rows for the record's genres and
 * subgenres, verified or not, and a `tag_occurrence` row per name. A tag the
 * record no longer gives loses its Sonovault mark; the row stays only while
 * the owner marked it. The owner's marks are never read or changed. With
 * `apply: false` nothing is written and the counts say what would change.
 */
export async function recordSonovaultTrackTags(
  database: TagWriter,
  entries: SonovaultTrackTagsEntry[],
  {
    apply = true,
    nameMap = sonovaultTagNameMap,
  }: { apply?: boolean; nameMap?: ReadonlyMap<string, string> } = {},
): Promise<TrackTagsWritten> {
  const latest = new Map<string, SonovaultTrackTagsEntry>()
  for (const entry of entries) latest.set(entry.mediaItemId, entry)
  const tracks = [...latest.values()]
  const written: TrackTagsWritten = {
    tracks: tracks.length,
    rows: 0,
    verifiedRows: 0,
    inserted: 0,
    updated: 0,
    cleared: 0,
    occurrences: 0,
    created: [],
    names: new Map(),
  }
  if (!tracks.length) return written
  if (apply) await lockTrackTagWrites(database)

  const names: {
    entry: SonovaultTrackTagsEntry
    rawName: string
    name: string
    kind: SonovaultTagKind
  }[] = []
  for (const entry of tracks)
    for (const kind of ['genre', 'subgenre'] as const)
      for (const rawName of entry.record?.[kind] ?? [])
        if (normalizeTagName(rawName))
          names.push({
            entry,
            rawName,
            name: sonovaultTagName(rawName, nameMap),
            kind,
          })
  const resolved = await resolveProviderTagNames(database, 'album', names, {
    create: apply,
  })
  const createdNames = new Set(resolved.created)
  const aliases = apply
    ? await canonicalTagIds(database, [
        ...new Set(resolved.tagIds.filter((id) => id !== null)),
      ])
    : new Map<string, string>()

  const desired = new Map<string, Row>()
  const occurrences: (typeof tagOccurrence.$inferInsert)[] = []
  names.forEach((item, index) => {
    const resolvedId = resolved.tagIds[index]
    if (!resolvedId) return
    const tagId = aliases.get(resolvedId) ?? resolvedId
    const sonovaultName = normalizeTagName(item.rawName)
    written.names.set(sonovaultName, tagId)
    if (createdNames.has(normalizeTagName(item.name)))
      written.created.push(sonovaultName)
    const { entry } = item
    desired.set(key(entry.mediaItemId, tagId), {
      mediaItemId: entry.mediaItemId,
      tagId,
      verified: entry.verified,
      responseId: entry.responseId,
      fetchedAt: entry.fetchedAt,
    })
    occurrences.push(
      providerTagOccurrence(entry.mediaItemId, tagId, PROVIDER, {
        name: item.name,
        rawName: item.rawName,
        kind: item.kind,
      }),
    )
  })
  written.rows = desired.size
  written.verifiedRows = [...desired.values()].filter(
    (row) => row.verified,
  ).length

  for (let start = 0; start < tracks.length; start += TRACK_BATCH) {
    const ids = tracks
      .slice(start, start + TRACK_BATCH)
      .map((entry) => entry.mediaItemId)
    const batch = new Set(ids)
    const existing = ExistingRowsSchema.parse(
      (
        await database.execute(sql`
          select media_item_id, tag_id, sonovault, verified, response_id,
            to_char(fetched_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as fetched_at, owner
          from track_tag where media_item_id = any(${textArray(ids)})`)
      ).rows,
    )
    const current = new Map(
      existing.map((row) => [key(row.media_item_id, row.tag_id), row]),
    )
    const wanted = [...desired.values()].filter((row) =>
      batch.has(row.mediaItemId),
    )
    const writes = wanted.filter((row) => {
      const before = current.get(key(row.mediaItemId, row.tagId))
      return (
        !before ||
        !before.sonovault ||
        before.verified !== row.verified ||
        before.response_id !== row.responseId ||
        before.fetched_at !== row.fetchedAt.toISOString()
      )
    })
    const inserts = writes.filter(
      (row) => !current.has(key(row.mediaItemId, row.tagId)),
    ).length
    written.inserted += inserts
    written.updated += writes.length - inserts
    const dropped = existing.filter(
      (row) =>
        row.sonovault && !desired.has(key(row.media_item_id, row.tag_id)),
    )
    written.cleared += dropped.length

    const occurrenceRows = occurrences.filter((row) =>
      batch.has(row.mediaItemId),
    )
    const existingOccurrences = await database
      .select({ id: tagOccurrence.id, tagId: tagOccurrence.tagId })
      .from(tagOccurrence)
      .where(
        and(
          inArray(tagOccurrence.mediaItemId, ids),
          eq(tagOccurrence.provider, PROVIDER),
        ),
      )
    const occurrenceIds = new Set(occurrenceRows.map((row) => row.id))
    const staleOccurrences = existingOccurrences
      .filter((row) => !occurrenceIds.has(row.id))
      .map((row) => row.id)
    const occurrenceTags = new Map(
      existingOccurrences.map((row) => [row.id, row.tagId]),
    )
    const occurrenceWrites = occurrenceRows.filter(
      (row) => occurrenceTags.get(row.id) !== row.tagId,
    )
    written.occurrences += staleOccurrences.length + occurrenceWrites.length
    if (!apply) continue

    const droppedPairs = dropped.map((row) => ({
      mediaItemId: row.media_item_id,
      tagId: row.tag_id,
    }))
    if (droppedPairs.length) {
      // Delete first: a row left with no mark at all would fail its check.
      await database.execute(sql`
        delete from track_tag tt
        using jsonb_to_recordset(${pairs(droppedPairs)}::jsonb) d(media_item_id text, tag_id text)
        where tt.media_item_id = d.media_item_id and tt.tag_id = d.tag_id
          and tt.owner is null`)
      await database.execute(sql`
        update track_tag tt set sonovault = false, verified = false,
          response_id = null, fetched_at = null, updated_at = now()
        from jsonb_to_recordset(${pairs(droppedPairs)}::jsonb) d(media_item_id text, tag_id text)
        where tt.media_item_id = d.media_item_id and tt.tag_id = d.tag_id
          and tt.sonovault`)
    }
    if (writes.length)
      await database
        .insert(trackTag)
        .values(
          writes.map((row) => ({
            mediaItemId: row.mediaItemId,
            tagId: row.tagId,
            sonovault: true,
            verified: row.verified,
            responseId: row.responseId,
            fetchedAt: row.fetchedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [trackTag.mediaItemId, trackTag.tagId],
          set: {
            sonovault: true,
            verified: sql`excluded.verified`,
            responseId: sql`excluded.response_id`,
            fetchedAt: sql`excluded.fetched_at`,
            updatedAt: sql`now()`,
          },
        })
    if (staleOccurrences.length)
      await database
        .delete(tagOccurrence)
        .where(inArray(tagOccurrence.id, staleOccurrences))
    await upsertTagOccurrences(database, occurrenceWrites)
  }
  return written
}

/** Drops Sonovault's rows and occurrences on tracks, keeping the owner's. */
export async function clearSonovaultTrackTags(
  database: TagWriter,
  trackIds: string[],
) {
  return recordSonovaultTrackTags(
    database,
    trackIds.map((mediaItemId) => ({
      mediaItemId,
      record: null,
      verified: false,
      responseId: null,
      fetchedAt: new Date(0),
    })),
  )
}

/**
 * SONO-10 for track tags (TTAG-09): Sonovault's occurrences go, every row
 * loses its Sonovault mark, and rows with no owner mark are deleted.
 */
export async function removeSonovaultTrackTags(database: TagWriter) {
  await lockTrackTagWrites(database)
  await database
    .delete(tagOccurrence)
    .where(eq(tagOccurrence.provider, PROVIDER))
  const deleted = await database.execute(
    sql`delete from track_tag where sonovault and owner is null`,
  )
  await database.execute(sql`
    update track_tag set sonovault = false, verified = false, response_id = null,
      fetched_at = null, updated_at = now()
    where sonovault`)
  return deleted.rowCount ?? 0
}

/** A library track and the canonical album-library tag an owner edit names. */
async function ownerEditTarget(
  database: TagWriter,
  trackId: string,
  tagId: string,
) {
  await lockTrackTagWrites(database)
  const [track] = await database
    .select({ id: libraryTrack.mediaItemId })
    .from(libraryTrack)
    .where(eq(libraryTrack.mediaItemId, trackId))
  if (!track) throw new ServerError({ statusCode: 404, message: 'Not found' })
  const [target] = await database
    .select({ id: sql<string>`coalesce(${tagAlias.targetTagId}, ${tag.id})` })
    .from(tag)
    .leftJoin(tagAlias, eq(tagAlias.sourceTagId, tag.id))
    .where(and(eq(tag.id, tagId), eq(tag.mediaType, 'album')))
  if (!target)
    throw new ServerError({ statusCode: 404, message: 'Tag not found' })
  return target.id
}

/** TTAG-04: the owner adds a tag to a track, or restores a removed one. */
export async function addTrackTag(trackId: string, tagId: string) {
  return db.transaction(async (tx) => {
    const target = await ownerEditTarget(tx, trackId, tagId)
    const changed = await tx
      .insert(trackTag)
      .values({
        mediaItemId: trackId,
        tagId: target,
        owner: 'added',
        ownerChangedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [trackTag.mediaItemId, trackTag.tagId],
        set: {
          owner: 'added',
          ownerChangedAt: new Date(),
          updatedAt: new Date(),
        },
        setWhere: sql`${trackTag.owner} is distinct from 'added'`,
      })
      .returning({ tagId: trackTag.tagId })
    return { tagId: target, changed: changed.length > 0 }
  })
}

/**
 * TTAG-04: the owner removes a tag from a track. The row stays, marked, so a
 * later Sonovault refresh cannot bring the tag back.
 */
export async function removeTrackTag(trackId: string, tagId: string) {
  return db.transaction(async (tx) => {
    const target = await ownerEditTarget(tx, trackId, tagId)
    const changed = await tx
      .update(trackTag)
      .set({
        owner: 'removed',
        ownerChangedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(trackTag.mediaItemId, trackId),
          eq(trackTag.tagId, target),
          sql`${trackTag.owner} is distinct from 'removed'`,
        ),
      )
      .returning({ tagId: trackTag.tagId })
    return { tagId: target, changed: changed.length > 0 }
  })
}

/** TTAG-04 **Reset to Sonovault**: clears the owner's marks on a track. */
export async function resetTrackTags(trackId: string) {
  return db.transaction(async (tx) => {
    await lockTrackTagWrites(tx)
    const [track] = await tx
      .select({ id: libraryTrack.mediaItemId })
      .from(libraryTrack)
      .where(eq(libraryTrack.mediaItemId, trackId))
    if (!track) throw new ServerError({ statusCode: 404, message: 'Not found' })
    const deleted = await tx
      .delete(trackTag)
      .where(
        and(eq(trackTag.mediaItemId, trackId), eq(trackTag.sonovault, false)),
      )
      .returning({ tagId: trackTag.tagId })
    const cleared = await tx
      .update(trackTag)
      .set({ owner: null, ownerChangedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(trackTag.mediaItemId, trackId),
          sql`${trackTag.owner} is not null`,
        ),
      )
      .returning({ tagId: trackTag.tagId })
    return { changed: deleted.length + cleared.length }
  })
}

const TagRecordSchema = SonovaultTrackSchema.pick({
  id: true,
  genre: true,
  subgenre: true,
})
const BodyListSchema = z.object({
  results: z.array(z.object({ track: z.unknown() }).passthrough()).optional(),
  tracks: z.array(z.unknown()).optional(),
})

/**
 * The tags of every track record in a stored Sonovault body, by Sonovault
 * track ID: a bulk result list, a release's track list or one track.
 */
export function storedSonovaultTagRecords(text: string) {
  const records = new Map<string, SonovaultTrackTags>()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return records
  }
  const lists = BodyListSchema.safeParse(body)
  const candidates = lists.success
    ? [
        ...(lists.data.results ?? []).map((result) => result.track),
        ...(lists.data.tracks ?? []),
        body,
      ]
    : [body]
  for (const candidate of candidates) {
    // One malformed record does not hide the others.
    const parsed = TagRecordSchema.safeParse(candidate)
    if (parsed.success)
      records.set(String(parsed.data.id), {
        genre: parsed.data.genre,
        subgenre: parsed.data.subgenre,
      })
  }
  return records
}

const LookupRowsSchema = z.array(
  z.object({
    media_item_id: z.string(),
    status: z.string(),
    sonovault_track_id: z.string().nullable(),
    verified: z.boolean().nullable(),
    response_id: z.string().nullable(),
    looked_up_at: z.string(),
    // The tags of the record the lookup row keeps, when it keeps one.
    record_tags: z.unknown(),
  }),
)
const StoredTagsSchema = TagRecordSchema.pick({ genre: true, subgenre: true })
const lookupRows = (where: SQL) => sql`
  select l.media_item_id, l.status, l.sonovault_track_id, l.verified, l.response_id,
    to_char(l.looked_up_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as looked_up_at,
    case when l.record is not null then jsonb_build_object(
      'genre', l.record->'track'->'genre', 'subgenre', l.record->'track'->'subgenre') end
      as record_tags
  from sonovault_track_lookup l
  join library_track lt on lt.media_item_id = l.media_item_id
  where ${where}`
const lookupState = (row: z.infer<typeof LookupRowsSchema>[number]) =>
  JSON.stringify([row.status, row.response_id, row.looked_up_at])

type BackfillDatabase = TagWriter & Pick<typeof db, 'transaction'>

/**
 * TTAG-07: records the tags of each library track's latest Sonovault lookup:
 * the record the lookup row keeps, or for a row stored before rows kept it,
 * the record found by its Sonovault track ID in the response the row names. Makes no requests; a second run changes nothing.
 * Dry run unless `apply`. Each batch of tracks is written under the
 * Sonovault writers' lock, skipping a track whose lookup changed meanwhile.
 */
export async function applyStoredSonovaultTrackTags(
  database: BackfillDatabase,
  {
    apply = false,
    nameMap = sonovaultTagNameMap,
  }: { apply?: boolean; nameMap?: ReadonlyMap<string, string> } = {},
) {
  const lookups = LookupRowsSchema.parse(
    (await database.execute(lookupRows(sql`true`))).rows,
  )
  const orphaned = z.array(z.object({ media_item_id: z.string() })).parse(
    (
      await database.execute(sql`
          select distinct t.media_item_id from track_tag t
          where t.sonovault and not exists (
            select 1 from sonovault_track_lookup l where l.media_item_id = t.media_item_id)`)
    ).rows,
  )
  const entries: SonovaultTrackTagsEntry[] = []
  const state = new Map<string, string>()
  const byResponse = new Map<string, typeof lookups>()
  let fromRecords = 0
  let missing = 0
  for (const lookup of lookups) {
    if (lookup.status !== 'matched') continue
    const kept = StoredTagsSchema.safeParse(lookup.record_tags)
    if (kept.success) {
      fromRecords += 1
      state.set(lookup.media_item_id, lookupState(lookup))
      entries.push({
        mediaItemId: lookup.media_item_id,
        record: kept.data,
        verified: lookup.verified === true,
        responseId: lookup.response_id,
        fetchedAt: new Date(lookup.looked_up_at),
      })
    } else if (lookup.response_id && lookup.sonovault_track_id) {
      const rows = byResponse.get(lookup.response_id) ?? []
      rows.push(lookup)
      byResponse.set(lookup.response_id, rows)
    } else missing += 1
  }
  const responseIds = [...byResponse.keys()]
  for (let start = 0; start < responseIds.length; start += RESPONSE_BATCH) {
    const batch = responseIds.slice(start, start + RESPONSE_BATCH)
    const bodies = await database
      .select({
        id: providerResponse.id,
        text: sql<string | null>`${providerResponse.body}->>'text'`,
      })
      .from(providerResponse)
      .where(inArray(providerResponse.id, batch))
    const bodyById = new Map(bodies.map((body) => [body.id, body]))
    for (const responseId of batch) {
      const body = bodyById.get(responseId)
      const records = body?.text ? storedSonovaultTagRecords(body.text) : null
      for (const lookup of byResponse.get(responseId) ?? []) {
        const record =
          lookup.sonovault_track_id && records?.get(lookup.sonovault_track_id)
        if (!body || !record) {
          missing += 1
          continue
        }
        state.set(lookup.media_item_id, lookupState(lookup))
        entries.push({
          mediaItemId: lookup.media_item_id,
          record,
          verified: lookup.verified === true,
          responseId,
          // The lookup's time is the response's, as the lookup job writes it.
          fetchedAt: new Date(lookup.looked_up_at),
        })
      }
    }
  }
  // A track Sonovault no longer finds, or whose lookup is gone, keeps only
  // the owner's rows.
  for (const lookup of lookups)
    if (lookup.status !== 'matched') {
      state.set(lookup.media_item_id, lookupState(lookup))
      entries.push({
        mediaItemId: lookup.media_item_id,
        record: null,
        verified: false,
        responseId: null,
        fetchedAt: new Date(0),
      })
    }
  for (const row of orphaned)
    entries.push({
      mediaItemId: row.media_item_id,
      record: null,
      verified: false,
      responseId: null,
      fetchedAt: new Date(0),
    })

  const totals = {
    apply,
    lookups: lookups.length,
    fromRecords,
    responses: responseIds.length,
    recordsMissing: missing,
    tracks: 0,
    tracksWithTags: 0,
    rows: 0,
    verifiedRows: 0,
    inserted: 0,
    updated: 0,
    cleared: 0,
    occurrences: 0,
    skippedChanged: 0,
  }
  const created = new Set<string>()
  const names = new Map<string, string>()
  const add = (written: TrackTagsWritten) => {
    totals.rows += written.rows
    totals.verifiedRows += written.verifiedRows
    totals.inserted += written.inserted
    totals.updated += written.updated
    totals.cleared += written.cleared
    totals.occurrences += written.occurrences
    for (const name of written.created) created.add(name)
    for (const [name, tagId] of written.names) names.set(name, tagId)
  }
  for (let start = 0; start < entries.length; start += TRACK_BATCH) {
    const batch = entries.slice(start, start + TRACK_BATCH)
    if (!apply) {
      add(await recordSonovaultTrackTags(database, batch, { apply, nameMap }))
      totals.tracks += batch.length
      totals.tracksWithTags += batch.filter(
        (entry) => entry.record?.genre.length || entry.record?.subgenre.length,
      ).length
      continue
    }
    await database.transaction(async (tx) => {
      await lockLibraryTrackWrites(tx)
      const now = new Map(
        LookupRowsSchema.parse(
          (
            await tx.execute(
              lookupRows(
                sql`l.media_item_id = any(${textArray(batch.map((entry) => entry.mediaItemId))})`,
              ),
            )
          ).rows,
        ).map((row) => [row.media_item_id, lookupState(row)]),
      )
      const unchanged = batch.filter(
        (entry) => now.get(entry.mediaItemId) === state.get(entry.mediaItemId),
      )
      totals.skippedChanged += batch.length - unchanged.length
      add(await recordSonovaultTrackTags(tx, unchanged, { apply, nameMap }))
      totals.tracks += unchanged.length
      totals.tracksWithTags += unchanged.filter(
        (entry) => entry.record?.genre.length || entry.record?.subgenre.length,
      ).length
    })
  }

  // Where each name sits in the album hierarchy: a name created here, or
  // one whose tag has no parent or child, is outside it.
  const tagIds = [...new Set(names.values())]
  const placed = new Map<string, { hidden: boolean; placed: boolean }>()
  for (let start = 0; start < tagIds.length; start += 1000)
    for (const row of z
      .array(
        z.object({ id: z.string(), hidden: z.boolean(), placed: z.boolean() }),
      )
      .parse(
        (
          await database.execute(sql`
            select t.id, t.hidden, exists (
              select 1 from tag_parent p where p.media_type = 'album'
                and ${normalizedTagSql(sql`t.name`)} in (p.child_key, p.parent_key)) as placed
            from tag t where t.id = any(${textArray(tagIds.slice(start, start + 1000))})`)
        ).rows,
      ))
      placed.set(row.id, row)
  const outside = [...names].filter(
    ([name, tagId]) => created.has(name) || !placed.get(tagId)?.placed,
  )
  return {
    ...totals,
    verifiedShare: totals.rows
      ? Math.round((totals.verifiedRows / totals.rows) * 1000) / 10
      : 0,
    names: names.size,
    namesCreated: created.size,
    namesOutsideHierarchy: outside.length,
    namesOnHiddenTags: [...names.values()].filter(
      (tagId) => placed.get(tagId)?.hidden,
    ).length,
  }
}
