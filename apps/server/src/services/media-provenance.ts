import { asc, desc, eq, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { PluginCreditSchema } from '@repo/media-plugin-sdk'
import { JsonValueSchema, type JsonValue } from '@repo/schemas/common'
import {
  MediaProvenanceSchema,
  type FieldOverride,
  type FieldSource,
  type MediaFieldProvenance,
  type MediaProvenance,
} from '@repo/schemas/provenance'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { parseOptionalDate } from '@/lib/media-utils'
import {
  artist,
  mediaCredit,
  mediaOverride,
  providerCurrentState,
  providerSnapshot,
} from '@/schemas/db'
import { listBrowseFields } from './browse'
import { normalizeCreditsForInsert } from './provider-state'

type MediaType = MediaProvenance['mediaType']
type Patch = 'mediaPatch' | 'typePatch'
type ColumnField = {
  key: string
  label: string
  patch: Patch
  date?: true
}

// The stored columns provider-state.ts writes from each normalized patch.
const mediaColumns: ColumnField[] = [
  { key: 'title', label: 'Title', patch: 'mediaPatch' },
  { key: 'originalTitle', label: 'Original title', patch: 'mediaPatch' },
  { key: 'summary', label: 'Description', patch: 'mediaPatch' },
  { key: 'artworkUrl', label: 'Artwork URL', patch: 'mediaPatch' },
  {
    key: 'releaseDate',
    label: 'Release date',
    patch: 'mediaPatch',
    date: true,
  },
  { key: 'sourceLabel', label: 'Source', patch: 'mediaPatch' },
]
const typeColumns: Record<MediaType, ColumnField[]> = {
  album: [
    {
      key: 'dateAdded',
      label: 'Stored date added',
      patch: 'typePatch',
      date: true,
    },
    { key: 'durationSec', label: 'Duration', patch: 'typePatch' },
    { key: 'spotifyUrl', label: 'Spotify URL', patch: 'typePatch' },
  ],
  film: [
    { key: 'dateAdded', label: 'Date added', patch: 'typePatch', date: true },
    { key: 'runtimeMinutes', label: 'Runtime', patch: 'typePatch' },
    { key: 'watched', label: 'Watched', patch: 'typePatch' },
    { key: 'sourceKind', label: 'Source kind', patch: 'typePatch' },
    { key: 'budget', label: 'Budget', patch: 'typePatch' },
    { key: 'boxOffice', label: 'Box office', patch: 'typePatch' },
  ],
}
const creditLabels: Record<string, string> = {
  artist: 'Artists',
  director: 'Directors',
  actor: 'Actors',
  writer: 'Writers',
}

const JsonRecordSchema = z.record(z.string(), JsonValueSchema)
const ItemRowsSchema = z.array(
  z.object({
    media_type: z.enum(['album', 'film', 'track']),
    columns: JsonRecordSchema,
    media_metadata: JsonRecordSchema.nullable(),
    type_metadata: JsonRecordSchema.nullable(),
    type_columns: JsonRecordSchema.nullable(),
  }),
)
const StateRowSchema = z.object({
  provider: z.string(),
  snapshotId: z.string().nullable(),
  snapshotSource: z.string().nullable(),
  jobId: z.string().nullable(),
  snapshotAt: z.date().nullable(),
  appliedAt: z.date().nullable(),
  mediaPatch: JsonRecordSchema.nullable(),
  mediaBrowse: JsonRecordSchema.nullable(),
  typePatch: JsonRecordSchema.nullable(),
  typeBrowse: JsonRecordSchema.nullable(),
  credits: z.array(z.unknown()).nullable(),
})
type StateRow = z.infer<typeof StateRowSchema>

const isRecord = (
  value: JsonValue | undefined,
): value is { [key: string]: JsonValue } =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function sameJson(left: JsonValue, right: JsonValue): boolean {
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => {
        const other = right[index]
        return other !== undefined && sameJson(value, other)
      })
    )
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false
    const keys = Object.keys(left)
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => {
        const value = left[key]
        const other = right[key]
        return (
          value !== undefined && other !== undefined && sameJson(value, other)
        )
      })
    )
  }
  return left === right
}

// Dates are compared as the writer stores them: parsed to a UTC instant.
const sameDate = (supplied: JsonValue, stored: JsonValue) =>
  typeof supplied === 'string' &&
  parseOptionalDate(supplied)?.toISOString() === stored

const sameNames = (supplied: string[], stored: JsonValue) =>
  Array.isArray(stored) &&
  supplied.length === stored.length &&
  supplied.every(
    (name, index) =>
      name.toLowerCase() === String(stored[index] ?? '').toLowerCase(),
  )

function source(
  state: StateRow,
  value: JsonValue,
  matchesCurrent: boolean,
): FieldSource {
  return {
    provider: state.provider,
    scrapedAt: (state.snapshotAt ?? state.appliedAt)?.toISOString() ?? null,
    snapshotId: state.snapshotId,
    snapshotSource: state.snapshotSource,
    jobId: state.jobId,
    value,
    matchesCurrent,
  }
}

function creditNames(state: StateRow, role: string) {
  const credits = z.array(PluginCreditSchema).safeParse(state.credits ?? [])
  if (!credits.success) return []
  return normalizeCreditsForInsert(
    credits.data.filter((credit) => credit.role === role),
  ).map((credit) => credit.name)
}

async function loadItem(id: string) {
  const [item] = ItemRowsSchema.parse(
    (
      await db.execute(sql`
        select m.media_type,
          jsonb_build_object(
            'title', m.title, 'originalTitle', m.original_title,
            'summary', m.summary, 'artworkUrl', m.artwork_url,
            'releaseDate', ${isoInstant(sql`m.release_date`)},
            'sourceLabel', m.source_label) as columns,
          m.metadata as media_metadata,
          coalesce(a.metadata, f.metadata) as type_metadata,
          case
            when a.media_item_id is not null then jsonb_build_object(
              'dateAdded', ${isoInstant(sql`a.date_added`)},
              'durationSec', a.duration_sec, 'spotifyUrl', a.spotify_url)
            when f.media_item_id is not null then jsonb_build_object(
              'dateAdded', ${isoInstant(sql`f.date_added`)},
              'runtimeMinutes', f.runtime_minutes, 'watched', f.watched,
              'sourceKind', f.source_kind, 'budget', f.budget,
              'boxOffice', f.box_office)
          end as type_columns
        from media_item m
        left join album a on a.media_item_id = m.id
        left join film f on f.media_item_id = m.id
        where m.id = ${id}`)
    ).rows,
  )
  if (!item || item.media_type === 'track' || !item.type_columns)
    throw new ServerError({ statusCode: 404, message: 'Media item not found' })
  return {
    ...item,
    media_type: item.media_type,
    type_columns: item.type_columns,
  }
}

// Matches the detail response: a timestamp without time zone read as UTC.
function isoInstant(column: SQL) {
  return sql`to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
}

async function loadStates(id: string) {
  const patch = (name: string) =>
    sql`(${providerCurrentState.normalizedData}->${name}) - 'metadata'`
  const browse = (name: string) =>
    sql`${providerCurrentState.normalizedData}->${name}->'metadata'->'browse'`
  // Read only the patches and credits, never the payload or other results.
  const rows = await db
    .select({
      provider: providerCurrentState.provider,
      snapshotId: providerCurrentState.latestSnapshotId,
      snapshotSource: providerSnapshot.source,
      jobId: providerSnapshot.scrapeJobId,
      snapshotAt: providerSnapshot.createdAt,
      appliedAt: providerCurrentState.lastSuccessfulAt,
      mediaPatch: patch('mediaPatch'),
      mediaBrowse: browse('mediaPatch'),
      albumPatch: patch('albumPatch'),
      albumBrowse: browse('albumPatch'),
      filmPatch: patch('filmPatch'),
      filmBrowse: browse('filmPatch'),
      credits: sql`${providerCurrentState.normalizedData}->'credits'`,
    })
    .from(providerCurrentState)
    .leftJoin(
      providerSnapshot,
      eq(providerSnapshot.id, providerCurrentState.latestSnapshotId),
    )
    .where(eq(providerCurrentState.mediaItemId, id))
  return rows
}

async function loadOverrides(id: string) {
  const rows = await db
    .select({
      field: mediaOverride.field,
      createdAt: mediaOverride.createdAt,
      by: mediaOverride.createdByUserId,
      note: mediaOverride.note,
    })
    .from(mediaOverride)
    .where(eq(mediaOverride.mediaItemId, id))
    .orderBy(desc(mediaOverride.createdAt), desc(mediaOverride.id))
  const latest = new Map<string, FieldOverride>()
  for (const row of rows)
    if (!latest.has(row.field))
      latest.set(row.field, {
        at: row.createdAt.toISOString(),
        by: row.by,
        note: row.note,
      })
  return latest
}

async function loadCredits(id: string) {
  const rows = await db
    .select({ role: mediaCredit.role, name: artist.name })
    .from(mediaCredit)
    .innerJoin(artist, eq(artist.id, mediaCredit.artistId))
    .where(eq(mediaCredit.mediaItemId, id))
    .orderBy(
      asc(mediaCredit.role),
      asc(mediaCredit.billingOrder),
      asc(artist.name),
    )
  const byRole = new Map<string, string[]>()
  for (const row of rows)
    byRole.set(row.role, [...(byRole.get(row.role) ?? []), row.name])
  return byRole
}

/**
 * Where each stored album or film value came from, derived at read time.
 * Lists every provider whose current normalized result supplies a field;
 * the app does not record which provider's write was applied last.
 */
export async function getMediaProvenance(id: string): Promise<MediaProvenance> {
  const item = await loadItem(id)
  const mediaType = item.media_type
  const [rawStates, overrides, credits, browseFields] = await Promise.all([
    loadStates(id),
    loadOverrides(id),
    loadCredits(id),
    listBrowseFields(mediaType),
  ])
  const states = rawStates
    .map((row) =>
      StateRowSchema.parse({
        ...row,
        typePatch: mediaType === 'album' ? row.albumPatch : row.filmPatch,
        typeBrowse: mediaType === 'album' ? row.albumBrowse : row.filmBrowse,
      }),
    )
    .sort(
      (left, right) =>
        ((right.snapshotAt ?? right.appliedAt)?.getTime() ?? 0) -
          ((left.snapshotAt ?? left.appliedAt)?.getTime() ?? 0) ||
        left.provider.localeCompare(right.provider),
    )

  const fields: MediaFieldProvenance[] = []
  const add = (
    key: string,
    label: string,
    value: JsonValue,
    sources: FieldSource[],
    override: FieldOverride | null = null,
  ) => {
    if (value !== null || override || sources.length)
      fields.push({ key, label, value, override, sources })
  }

  for (const column of [...mediaColumns, ...typeColumns[mediaType]]) {
    const stored =
      (column.patch === 'mediaPatch' ? item.columns : item.type_columns)[
        column.key
      ] ?? null
    add(
      column.key,
      column.label,
      stored,
      states.flatMap((state) => {
        const supplied = state[column.patch]?.[column.key]
        if (supplied === undefined || supplied === null) return []
        return [
          source(
            state,
            supplied,
            column.date
              ? sameDate(supplied, stored)
              : sameJson(supplied, stored),
          ),
        ]
      }),
      overrides.get(column.key) ?? null,
    )
  }

  // Detail pages show the shallow merge of the type and media metadata.
  const metadata = { ...item.type_metadata, ...item.media_metadata }
  const browse = isRecord(metadata.browse) ? metadata.browse : {}
  const columnKeys = new Set(
    [...mediaColumns, ...typeColumns[mediaType]].map((column) => column.key),
  )
  for (const field of browseFields) {
    if (columnKeys.has(field.key)) continue
    const stored = browse[field.key] ?? null
    add(
      `browse.${field.key}`,
      field.label,
      stored,
      states.flatMap((state) => {
        const supplied =
          state.mediaBrowse?.[field.key] ?? state.typeBrowse?.[field.key]
        if (supplied === undefined || supplied === null) return []
        return [source(state, supplied, sameJson(supplied, stored))]
      }),
    )
  }

  const roles = new Set([
    ...credits.keys(),
    ...states.flatMap((state) =>
      z
        .array(PluginCreditSchema)
        .catch([])
        .parse(state.credits ?? [])
        .map((credit) => credit.role),
    ),
  ])
  for (const role of [...roles].sort()) {
    const stored = credits.get(role) ?? null
    add(
      `credits.${role}`,
      creditLabels[role] ?? role.charAt(0).toUpperCase() + role.slice(1),
      stored,
      states.flatMap((state) => {
        const supplied = creditNames(state, role)
        if (!supplied.length) return []
        return [source(state, supplied, sameNames(supplied, stored))]
      }),
    )
  }

  return MediaProvenanceSchema.parse({ mediaItemId: id, mediaType, fields })
}
