import { isDeepStrictEqual } from 'node:util'
import { and, desc, eq, inArray } from 'drizzle-orm'
import {
  PluginResultSchema,
  StoredPersonalStateSchema,
  type JsonValue,
} from '@repo/media-plugin-sdk'
import type { FilmImportPreview } from '@repo/schemas/imports'
import { db } from '@/lib/db'
import { resolveFileImportPatches } from '@/lib/file-import-patches'
import { filmAddedDate, NFO_CREATION_SOURCE } from '@/lib/film-added-date'
import { parseOptionalDate } from '@/lib/media-utils'
import { isJsonRecord } from '@/lib/provider-normalizers'
import {
  mediaItem,
  film,
  mediaOverride,
  providerReference,
  providerReferenceOverride,
  externalLink,
  mediaCredit,
  artist,
  mediaItemTag,
  tag,
  tagOccurrence,
  playlistItem,
  playlist,
  providerSnapshot,
} from '@/schemas/db'
import { listLoadedScrapePlugins } from '@/plugins/registry'
import type { FilmImportCandidate } from './file-imports'
import { normalizeCreditsForInsert } from './provider-state'

type Database = Pick<typeof db, 'select'>
type Change = FilmImportPreview['items'][number]['changes'][number]

// Batch reads keep a full CSV preview from doing a query per field per film.
export async function loadFilmImportState(
  ids: string[],
  database: Database = db,
) {
  const items = await database
    .select()
    .from(mediaItem)
    .where(inArray(mediaItem.id, ids))
  const films = await database
    .select()
    .from(film)
    .where(inArray(film.mediaItemId, ids))
  const overrides = await database
    .select()
    .from(mediaOverride)
    .where(inArray(mediaOverride.mediaItemId, ids))
  const references = await database
    .select()
    .from(providerReference)
    .where(inArray(providerReference.mediaItemId, ids))
  const referenceOverrides = await database
    .select()
    .from(providerReferenceOverride)
    .where(inArray(providerReferenceOverride.mediaItemId, ids))
  const links = await database
    .select()
    .from(externalLink)
    .where(inArray(externalLink.mediaItemId, ids))
  const credits = await database
    .select({
      mediaItemId: mediaCredit.mediaItemId,
      name: artist.name,
      role: mediaCredit.role,
      billingOrder: mediaCredit.billingOrder,
    })
    .from(mediaCredit)
    .innerJoin(artist, eq(artist.id, mediaCredit.artistId))
    .where(inArray(mediaCredit.mediaItemId, ids))
  const tags = await database
    .select({
      mediaItemId: mediaItemTag.mediaItemId,
      name: tag.name,
      kind: tag.kind,
    })
    .from(mediaItemTag)
    .innerJoin(tag, eq(tag.id, mediaItemTag.tagId))
    .where(inArray(mediaItemTag.mediaItemId, ids))
  const occurrences = await database
    .select()
    .from(tagOccurrence)
    .where(inArray(tagOccurrence.mediaItemId, ids))
  const playlists = await database
    .select({
      mediaItemId: playlistItem.mediaItemId,
      name: playlist.name,
      kind: playlist.kind,
    })
    .from(playlistItem)
    .innerJoin(playlist, eq(playlist.id, playlistItem.playlistId))
    .where(inArray(playlistItem.mediaItemId, ids))
  const readers = (await listLoadedScrapePlugins()).filter(
    (plugin) => plugin.readStoredPersonalState,
  )
  const snapshots = readers.length
    ? await database
        .select({
          mediaItemId: providerSnapshot.mediaItemId,
          provider: providerSnapshot.provider,
          payload: providerSnapshot.payload,
        })
        .from(providerSnapshot)
        .where(
          and(
            inArray(providerSnapshot.mediaItemId, ids),
            inArray(providerSnapshot.provider, [
              'legacy-record',
              ...readers.map((plugin) => plugin.manifest.id),
            ]),
          ),
        )
        .orderBy(desc(providerSnapshot.createdAt), desc(providerSnapshot.id))
    : []
  const personalStates: Array<{
    mediaItemId: string
    provider: string
    values: Record<string, JsonValue>
  }> = []
  for (const item of items) {
    const sourceKind =
      films.find((film) => film.mediaItemId === item.id)?.sourceKind ?? null
    for (const plugin of readers) {
      const values: Record<string, JsonValue> = {}
      const payloads = snapshots
        .filter(
          (row) =>
            row.mediaItemId === item.id &&
            (row.provider === plugin.manifest.id ||
              row.provider === 'legacy-record'),
        )
        .map((row) => row.payload)
      // The empty payload lets a plugin interpret a legacy source label even without a snapshot.
      for (const payload of [...payloads, null]) {
        const parsed = StoredPersonalStateSchema.safeParse(
          plugin.readStoredPersonalState?.({
            payload,
            sourceKind,
            sourceLabel: item.sourceLabel,
          }),
        )
        if (!parsed.success) continue
        for (const [key, value] of Object.entries(parsed.data))
          if (values[key] === undefined && value !== undefined)
            values[key] = value
      }
      personalStates.push({
        mediaItemId: item.id,
        provider: plugin.manifest.id,
        values,
      })
    }
  }
  return {
    items,
    films,
    overrides,
    references,
    referenceOverrides,
    links,
    credits,
    tags,
    occurrences,
    playlists,
    personalStates,
  }
}

const labels: Record<string, string> = {
  'metadata.browse.ratingImdbPersonal': 'Your IMDb rating',
  'metadata.browse.ratingImdbPersonalDate': 'IMDb rating date',
  'metadata.browse.ratingImdbValue': 'IMDb score',
  'metadata.browse.ratingImdbVotes': 'IMDb votes',
  'metadata.watchlist': 'Watchlist status',
  'metadata.bookmarked': 'Bookmark status',
  'metadata.bookmarkDate': 'Bookmark date',
  'metadata.legacyHidden': 'Restore to library',
  sourceLabel: 'Source label',
  sourceKind: 'Source',
  dateAdded: 'Added date',
  watched: 'Watched status',
  originalTitle: 'Original title',
  runtimeMinutes: 'Runtime',
}

function personalStateBefore(
  candidate: FilmImportCandidate,
  id: string,
  state: Awaited<ReturnType<typeof loadFilmImportState>>,
) {
  const retained =
    state.personalStates.find(
      (row) => row.mediaItemId === id && row.provider === candidate.provider,
    )?.values ?? {}
  const canonical = state.items.find((item) => item.id === id)?.metadata ?? {}
  return {
    ...retained,
    ...Object.fromEntries(
      Object.entries(canonical).filter(
        ([, value]) => value !== null && value !== '',
      ),
    ),
  }
}

export function existingFilmImportResult(
  candidate: FilmImportCandidate,
  id: string,
  state: Awaited<ReturnType<typeof loadFilmImportState>>,
) {
  if (candidate.provider === 'nfo') return candidate.result
  const { normalized } = candidate.result
  const metadata = normalized.mediaPatch?.metadata ?? {}
  const existingMetadata = personalStateBefore(candidate, id, state)
  const browse = metadata.browse
  const personal: Record<string, JsonValue> = {}
  for (const key of [
    'watchlist',
    'watchlistDate',
    'bookmarked',
    'bookmarkDate',
  ]) {
    const value = metadata[key]
    if (key.endsWith('Date')) {
      const date = filmAddedDate(value, 'CSV personal date')
      if (!date) continue
      const before = existingMetadata?.[key]
      if (
        filmAddedDate(before, 'CSV personal date')?.dateAdded !== date.dateAdded
      )
        personal[key] = date.dateAdded
    } else if (typeof value === 'boolean' && value !== existingMetadata[key])
      personal[key] = value
  }
  if (isJsonRecord(browse)) {
    const ratings: Record<string, JsonValue> = {}
    for (const key of ['ratingImdbPersonal', 'ratingImdbPersonalDate']) {
      const value = browse[key]
      if (value !== undefined) ratings[key] = value
    }
    if (Object.keys(ratings).length) personal.browse = ratings
  }
  const references = state.references.filter((row) => row.mediaItemId === id)
  const newReferences = normalized.references.filter((ref) => {
    const shared = ['imdb', 'tmdb'].includes(ref.referenceType)
    return (
      !references.some(
        (row) =>
          row.referenceType === ref.referenceType &&
          (shared || row.provider === candidate.provider),
      ) &&
      !state.referenceOverrides.some(
        (row) =>
          row.mediaItemId === id &&
          row.referenceType === ref.referenceType &&
          (row.provider === candidate.provider ||
            (shared && row.provider === ref.referenceType)),
      )
    )
  })
  // CSV exports are authoritative for personal state, not scraped metadata.
  // Keep provider-owned identifiers/links intact when adding a missing identifier.
  return PluginResultSchema.parse({
    payload: candidate.result.payload,
    normalized: {
      mediaPatch: { metadata: personal },
      filmPatch: {
        watched: normalized.filmPatch?.watched,
      },
      references: newReferences.length
        ? [
            ...references
              .filter((row) => row.provider === candidate.provider)
              .map((row) => ({
                referenceType: row.referenceType,
                externalId: row.externalId,
                isPrimary: row.isPrimary,
                metadata: row.metadata ?? undefined,
              })),
            ...newReferences,
          ]
        : [],
      links: newReferences.length
        ? [
            ...new Map(
              [
                ...state.links.filter(
                  (row) =>
                    row.mediaItemId === id &&
                    row.provider === candidate.provider,
                ),
                ...normalized.links,
              ].map((link) => [link.url, link]),
            ).values(),
          ]
        : [],
    },
  })
}

export function describeFilmImport(
  candidate: FilmImportCandidate,
  id: string,
  state: Awaited<ReturnType<typeof loadFilmImportState>>,
): Change[] {
  const item = state.items.find((item) => item.id === id)
  const existingFilm = state.films.find((film) => film.mediaItemId === id)
  if (!item || !existingFilm)
    throw new Error('Film no longer exists; preview again')
  const changes: Change[] = []
  const overridden = new Set(
    state.overrides
      .filter((row) => row.mediaItemId === id)
      .map((row) => row.field),
  )
  const add = (
    field: string,
    before: JsonValue | undefined,
    after: JsonValue | undefined,
    label?: string,
  ) => {
    if (after === undefined || isDeepStrictEqual(before ?? null, after)) return
    changes.push({
      field,
      label:
        label ??
        labels[field] ??
        field
          .replace(/^metadata\.(browse\.)?/, '')
          .replace(/([a-z])([A-Z])/g, '$1 $2'),
      before: before ?? null,
      after,
    })
  }
  const { normalized } = existingFilmImportResult(candidate, id, state)
  const { mediaPatch, filmPatch } = resolveFileImportPatches(
    normalized,
    item,
    existingFilm,
  )
  const mediaFields: Array<
    'title' | 'originalTitle' | 'summary' | 'artworkUrl' | 'sourceLabel'
  > = ['title', 'originalTitle', 'summary', 'artworkUrl', 'sourceLabel']
  for (const key of mediaFields) {
    const after = mediaPatch?.[key]
    if (!overridden.has(key) && after != null) add(key, item[key], after)
  }
  if (!overridden.has('releaseDate') && mediaPatch?.releaseDate)
    add(
      'releaseDate',
      item.releaseDate?.toISOString(),
      parseOptionalDate(mediaPatch.releaseDate)?.toISOString(),
      'Release date',
    )
  const filmFields: Array<
    'runtimeMinutes' | 'watched' | 'sourceKind' | 'budget' | 'boxOffice'
  > = ['runtimeMinutes', 'watched', 'sourceKind', 'budget', 'boxOffice']
  for (const key of filmFields) {
    const after = filmPatch?.[key]
    if (!overridden.has(key) && after != null)
      add(key, existingFilm[key], after)
  }
  const added = filmAddedDate(
    filmPatch?.dateAdded,
    filmPatch?.dateAddedSource ?? 'Imported source date (estimated)',
  )
  if (
    added &&
    !overridden.has('dateAdded') &&
    added.dateAddedSource !== 'NFO added date' &&
    (added.dateAddedSource === NFO_CREATION_SOURCE ||
      (existingFilm.dateAddedSource !== NFO_CREATION_SOURCE &&
        (!existingFilm.dateAdded ||
          new Date(added.dateAdded) < existingFilm.dateAdded)))
  ) {
    add('dateAdded', existingFilm.dateAdded?.toISOString(), added.dateAdded)
    if (
      existingFilm.dateAdded?.toISOString() === added.dateAdded &&
      existingFilm.dateAddedSource !== added.dateAddedSource
    )
      add(
        'dateAddedSource',
        existingFilm.dateAddedSource,
        added.dateAddedSource,
        'Added date source',
      )
  }
  function metadata(
    before: Record<string, JsonValue> | null,
    patch: Record<string, JsonValue> | undefined,
    prefix: string,
  ) {
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (key === 'legacyHidden' && value === false && before?.[key] !== true)
        continue
      if (key === 'browse' && isJsonRecord(value)) {
        const previous = before?.[key]
        for (const [name, next] of Object.entries(value))
          add(
            `${prefix}.browse.${name}`,
            isJsonRecord(previous) ? previous[name] : undefined,
            next,
          )
      } else add(`${prefix}.${key}`, before?.[key], value)
    }
  }
  metadata(
    personalStateBefore(candidate, id, state),
    mediaPatch?.metadata,
    'metadata',
  )
  metadata(existingFilm.metadata, filmPatch?.metadata, 'film.metadata')
  const references = state.references.filter((row) => row.mediaItemId === id)
  for (const ref of normalized.references) {
    const overrides = state.referenceOverrides
      .filter(
        (row) =>
          row.mediaItemId === id &&
          row.referenceType === ref.referenceType &&
          (row.provider === candidate.provider ||
            (['imdb', 'tmdb'].includes(row.provider) &&
              row.provider === row.referenceType)),
      )
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      )
    const externalId = overrides.at(-1)?.externalId ?? ref.externalId
    const shared = ['imdb', 'tmdb'].includes(ref.referenceType)
    const previous = references.filter(
      (row) =>
        row.referenceType === ref.referenceType &&
        (shared || row.provider === candidate.provider),
    )
    if (!previous.some((row) => row.externalId === externalId))
      add(
        `reference.${ref.referenceType}`,
        previous.map((row) => row.externalId),
        [externalId],
        `${shared ? (ref.referenceType === 'imdb' ? 'IMDb' : 'TMDb') : candidate.provider + ' ' + ref.referenceType} identifier`,
      )
  }
  for (const link of normalized.links) {
    if (
      !state.links.some(
        (row) =>
          row.mediaItemId === id &&
          row.url.replace(/\/$/, '') === link.url.replace(/\/$/, ''),
      )
    )
      add(`link.${link.label}`, null, link.url, `${link.label} link`)
  }
  for (const role of new Set(normalized.credits.map((credit) => credit.role))) {
    const existing = state.credits
      .filter((row) => row.mediaItemId === id && row.role === role)
      .sort((a, b) => a.billingOrder - b.billingOrder)
      .map((row) => row.name)
    const next = normalizeCreditsForInsert(normalized.credits)
      .filter((row) => row.role === role)
      .map((row) => row.name)
    add(`credits.${role}`, existing, next, role)
  }
  for (const incoming of normalized.tags) {
    const same = (name: string) =>
      name.trim().toLowerCase() === incoming.name.trim().toLowerCase()
    if (
      !state.tags.some(
        (row) =>
          row.mediaItemId === id &&
          row.kind === incoming.kind &&
          same(row.name),
      ) &&
      !state.occurrences.some(
        (row) =>
          row.mediaItemId === id &&
          row.kind === incoming.kind &&
          same(row.rawName),
      )
    )
      add(
        `tag.${incoming.kind}.${incoming.name}`,
        null,
        incoming.name,
        `Add ${incoming.kind}`,
      )
  }
  for (const membership of normalized.playlists) {
    if (
      !state.playlists.some(
        (row) =>
          row.mediaItemId === id &&
          row.kind === membership.kind &&
          row.name.toLowerCase() === membership.name.toLowerCase(),
      )
    )
      add(
        `membership.${membership.name}`,
        null,
        membership.name,
        `Add ${membership.kind}`,
      )
  }
  return changes
}
