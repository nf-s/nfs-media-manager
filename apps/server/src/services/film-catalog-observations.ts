import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { JsonValue, PluginNormalizedResult } from '@repo/media-plugin-sdk'
import { youtubeTrailerUrl } from '@repo/schemas/trailer'
import type { db } from '@/lib/db'
import { createStableId, parseOptionalDate } from '@/lib/media-utils'
import { isJsonRecord } from '@/lib/provider-normalizers'
import { tmdbPosterUrl } from '@/plugins/builtin/tmdb'
import {
  artist,
  mediaCredit,
  mediaItem,
  playlist,
  playlistItem,
  providerReference,
} from '@/schemas/db'
import {
  observeCatalogMedia,
  observeCatalogOccurrence,
  type CatalogOrigin,
} from './catalog-discoveries'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

const TmdbId = z
  .union([z.number().int().positive().safe(), z.string().regex(/^[1-9]\d*$/)])
  .transform(String)
const Name = z.string().trim().min(1).max(1000)
const ImagePath = z.string().regex(/^\/[A-Za-z0-9._-]+$/)
const MovieSummary = z.object({
  id: TmdbId,
  title: Name,
  poster_path: ImagePath.nullish().catch(null),
  release_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish()
    .catch(null),
  original_title: Name.nullish().catch(null),
})
const TmdbCredit = z.object({
  id: TmdbId.optional().catch(undefined),
  name: Name,
  credit_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional()
    .catch(undefined),
  character: Name.optional().catch(undefined),
  job: Name.optional().catch(undefined),
  department: Name.optional().catch(undefined),
  order: z.number().int().nonnegative().optional().catch(undefined),
  profile_path: ImagePath.nullish().catch(null),
})
const TmdbCollection = z.object({
  id: TmdbId,
  name: Name,
  poster_path: ImagePath.nullish().catch(null),
  backdrop_path: ImagePath.nullish().catch(null),
})
const TmdbNamedId = z.object({ id: TmdbId, name: Name })
const YoutubeVideo = z.object({
  site: z.literal('YouTube'),
  type: z.literal('Trailer'),
  key: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  official: z.boolean().optional().catch(undefined),
})

function records(value: JsonValue | undefined) {
  return Array.isArray(value)
    ? value
    : value === undefined || value === null
      ? []
      : [value]
}

function withPosition<T>(value: JsonValue | undefined, schema: z.ZodType<T>) {
  return records(value).flatMap((entry, position) => {
    const parsed = schema.safeParse(entry)
    return parsed.success ? [{ ...parsed.data, position }] : []
  })
}

function nfoRecord(value: JsonValue | undefined) {
  return records(value).find(isJsonRecord)
}

function nfoText(value: JsonValue | undefined) {
  for (const entry of records(value)) {
    const candidate = isJsonRecord(entry)
      ? (entry['#text'] ?? entry['_'])
      : entry
    const parsed = Name.safeParse(candidate)
    if (parsed.success) return parsed.data
  }
  return undefined
}

export function tmdbFilmCandidates(
  payload: JsonValue,
  field: 'movie_results' | 'results',
) {
  if (!isJsonRecord(payload)) return []
  return withPosition(payload[field], MovieSummary)
}

export async function observeFilmCandidate(
  tx: Transaction,
  candidate: {
    title: string
    externalId: string
    referenceType: string
    releaseDate?: string | null
    artworkUrl?: string | null
  },
  origin: CatalogOrigin,
) {
  const nativeType = candidate.referenceType
  const shared = nativeType === 'tmdb' || nativeType === 'imdb'
  if (
    (nativeType === 'tmdb' &&
      !TmdbId.safeParse(candidate.externalId).success) ||
    (nativeType === 'imdb' && !/^tt\d+$/.test(candidate.externalId))
  )
    return undefined
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('film-file-import'))`,
  )
  if (shared) {
    const members = await tx
      .selectDistinct({ id: mediaItem.id })
      .from(providerReference)
      .innerJoin(mediaItem, eq(mediaItem.id, providerReference.mediaItemId))
      .where(
        and(
          eq(mediaItem.mediaType, 'film'),
          eq(mediaItem.inLibrary, true),
          eq(providerReference.referenceType, nativeType),
          eq(providerReference.externalId, candidate.externalId),
          sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
        ),
      )
      .limit(2)
    const member = members.length === 1 ? members[0] : undefined
    if (member) {
      await observeCatalogOccurrence(
        tx,
        { kind: 'film', id: member.id },
        origin,
      )
      return member.id
    }
  }
  return observeCatalogMedia(
    tx,
    {
      kind: 'film',
      title: candidate.title,
      provider: origin.provider,
      referenceType: shared ? nativeType : 'provider-film-candidate',
      externalId: shared ? candidate.externalId : undefined,
      provisionalKey: shared
        ? undefined
        : createStableId(
            'film-provider-candidate',
            JSON.stringify([origin.provider, nativeType, candidate.externalId]),
          ),
      artworkUrl: origin.provider === 'tmdb' ? candidate.artworkUrl : undefined,
      releaseDate: parseOptionalDate(candidate.releaseDate),
    },
    origin,
  )
}

type FilmCredit = {
  name: string
  role: string
  position: number
  externalId?: string
  identityProvider?: string
  details?: Record<string, JsonValue>
}

function normalizedCredits(normalized: PluginNormalizedResult): FilmCredit[] {
  return normalized.credits.map(({ name, role, billingOrder }) => ({
    name,
    role,
    position: billingOrder,
  }))
}

function filmCredits(
  provider: string,
  data: Record<string, JsonValue>,
  normalized: PluginNormalizedResult,
): FilmCredit[] {
  if (provider === 'nfo') {
    const movie = nfoRecord(data['movie'])
    if (!movie) return normalizedCredits(normalized)
    const actors = records(movie['actor']).flatMap((entry, position) => {
      if (!isJsonRecord(entry)) return []
      const name = nfoText(entry['name'])
      if (!name) return []
      const externalId = TmdbId.safeParse(nfoText(entry['tmdbid'])).data
      return [
        {
          name,
          role: 'actor',
          position,
          externalId,
          identityProvider: externalId ? 'tmdb' : undefined,
          details: { character: nfoText(entry['role']) ?? null },
        },
      ]
    })
    const named = normalizedCredits(normalized)
    for (const [field, role] of [
      ['director', 'director'],
      ['credits', 'writer'],
    ]) {
      if (!field || !role || named.some((entry) => entry.role === role))
        continue
      for (const [position, entry] of records(movie[field]).entries()) {
        const name = nfoText(entry)
        if (name) named.push({ name, role, position })
      }
    }
    return actors.length
      ? [...named.filter((entry) => entry.role !== 'actor'), ...actors]
      : named
  }
  const credits = data['credits']
  if (provider !== 'tmdb' || !isJsonRecord(credits))
    return normalizedCredits(normalized)
  return ['cast', 'crew'].flatMap((group) =>
    withPosition(credits[group], TmdbCredit).map((credit) => {
      const role =
        group === 'cast'
          ? 'actor'
          : credit.job === 'Director'
            ? 'director'
            : ['Writer', 'Screenplay', 'Story'].includes(credit.job ?? '')
              ? 'writer'
              : 'crew'
      return {
        name: credit.name,
        role,
        position: credit.order ?? credit.position,
        externalId: credit.id,
        details: {
          creditId: credit.credit_id ?? null,
          character: credit.character ?? null,
          job: credit.job ?? null,
          department: credit.department ?? null,
          artworkUrl: tmdbPosterUrl(credit.profile_path) ?? null,
          creditGroup: group,
          sourcePosition: credit.position,
        },
      }
    }),
  )
}

function filmTrailers(
  data: Record<string, JsonValue>,
  normalized: PluginNormalizedResult,
) {
  const movie = nfoRecord(data['movie']) ?? data
  const explicit = [
    ...records(movie['trailer']).map((trailer) => nfoText(trailer)),
    ...normalized.links
      .filter((link) => link.provider === 'youtube-trailer')
      .map((link) => link.url),
  ].flatMap((value) => {
    const url = youtubeTrailerUrl(value)
    const id = url ? new URL(url).searchParams.get('v') : null
    return id ? [{ id, official: null }] : []
  })
  const videos = isJsonRecord(data['videos']) ? data['videos'] : {}
  return [
    ...explicit,
    ...withPosition(videos['results'], YoutubeVideo).map((video) => ({
      id: video.key,
      official: video.official ?? null,
    })),
  ]
}

function filmPayload(payload: JsonValue): Record<string, JsonValue> {
  if (!isJsonRecord(payload)) return {}
  if ('file' in payload && isJsonRecord(payload['data'])) return payload['data']
  return payload
}

async function observePerson(
  tx: Transaction,
  filmId: string,
  filmInLibrary: boolean,
  credit: FilmCredit,
  origin: CatalogOrigin,
) {
  const provider = credit.identityProvider ?? origin.provider
  const key = credit.externalId
    ? [provider, credit.externalId]
    : [provider, filmId, credit.role, credit.position, credit.name]
  const id = createStableId('catalog-film-person', JSON.stringify(key))
  await tx
    .insert(artist)
    .values({
      id,
      name: credit.name,
      sortName: credit.name,
      catalogProvider: provider,
      catalogExternalId: credit.externalId,
    })
    .onConflictDoNothing()
  const [existing] = credit.externalId
    ? await tx
        .select({ id: artist.id, mergedIntoId: artist.mergedIntoId })
        .from(artist)
        .where(
          and(
            eq(artist.catalogProvider, provider),
            eq(artist.catalogExternalId, credit.externalId),
          ),
        )
    : []
  const personId = existing?.mergedIntoId ?? existing?.id ?? id
  if (!filmInLibrary)
    await tx
      .insert(mediaCredit)
      .values({
        mediaItemId: filmId,
        artistId: personId,
        role: credit.role,
        billingOrder: credit.position,
      })
      .onConflictDoNothing()
  await observeCatalogOccurrence(
    tx,
    { kind: 'person', id: personId },
    {
      ...origin,
      relationshipRole: credit.role,
      occurrenceKey: JSON.stringify([
        origin.occurrenceKey,
        'credit',
        key,
        credit.details?.['sourcePosition'],
        credit.details?.['creditId'],
      ]),
      position: credit.position,
      details: {
        ...credit.details,
        name: credit.name,
        externalId: credit.externalId ?? null,
      },
    },
  )
}

export async function observeFilmRelations(
  tx: Transaction,
  filmId: string,
  payload: JsonValue,
  normalized: PluginNormalizedResult,
  source: CatalogOrigin,
) {
  const [film] = await tx
    .select({ inLibrary: mediaItem.inLibrary })
    .from(mediaItem)
    .where(eq(mediaItem.id, filmId))
  if (!film) return
  if (source.snapshotId)
    await observeCatalogOccurrence(tx, { kind: 'film', id: filmId }, source)
  const origin = { ...source, subjectKind: 'film', subjectId: filmId }
  const data = filmPayload(payload)
  for (const credit of filmCredits(origin.provider, data, normalized))
    await observePerson(tx, filmId, film.inLibrary, credit, origin)
  const nfoSet =
    origin.provider === 'nfo'
      ? nfoRecord(nfoRecord(data['movie'])?.['set'])
      : undefined
  const nfoSetName = nfoText(nfoSet?.['name'])
  const collection = TmdbCollection.safeParse(
    origin.provider === 'tmdb'
      ? data['belongs_to_collection']
      : nfoSet
        ? { id: nfoText(nfoSet['tmdbid']), name: nfoSetName }
        : null,
  )
  const memberships = [...normalized.playlists]
  if (
    nfoSetName &&
    !memberships.some(
      (entry) => entry.kind === 'collection' && entry.name === nfoSetName,
    )
  )
    memberships.push({ kind: 'collection', name: nfoSetName, position: 0 })
  for (const [position, entry] of memberships.entries()) {
    if (entry.kind !== 'collection') continue
    const exact =
      collection.success && collection.data.name === entry.name
        ? collection.data
        : null
    const key = exact
      ? ['tmdb', exact.id]
      : [origin.provider, filmId, entry.name, position]
    const nativeId = createStableId(
      'catalog-film-collection',
      JSON.stringify(key),
    )
    const [existing] = exact
      ? await tx
          .select({ id: playlist.id })
          .from(playlist)
          .where(
            and(
              eq(playlist.catalogProvider, 'tmdb'),
              eq(playlist.catalogExternalId, exact.id),
            ),
          )
      : []
    const [linked] = await tx
      .select({ id: playlist.id })
      .from(playlist)
      .innerJoin(playlistItem, eq(playlistItem.playlistId, playlist.id))
      .where(
        and(
          eq(playlistItem.mediaItemId, filmId),
          eq(playlist.kind, 'collection'),
          eq(playlist.name, entry.name),
          isNull(playlist.catalogProvider),
        ),
      )
      .limit(1)
    const collectionId =
      existing?.id ?? (exact ? nativeId : linked?.id) ?? nativeId
    if (collectionId === nativeId) {
      await tx
        .insert(playlist)
        .values({
          id: nativeId,
          kind: 'collection',
          name: entry.name,
          catalogProvider: exact ? 'tmdb' : origin.provider,
          catalogExternalId: exact?.id,
          artworkUrl: tmdbPosterUrl(exact?.poster_path),
        })
        .onConflictDoNothing()
      await tx
        .insert(playlistItem)
        .values({ playlistId: nativeId, mediaItemId: filmId })
        .onConflictDoNothing()
    }
    if (existing && (exact || !linked))
      await tx
        .insert(playlistItem)
        .values({ playlistId: collectionId, mediaItemId: filmId })
        .onConflictDoNothing()
    await observeCatalogOccurrence(
      tx,
      { kind: 'collection', id: collectionId },
      {
        ...origin,
        occurrenceKey: JSON.stringify([
          origin.occurrenceKey,
          'collection',
          key,
        ]),
        relationshipRole: 'collection',
        position,
        details: {
          name: entry.name,
          externalId: exact?.id ?? null,
          artworkUrl: tmdbPosterUrl(exact?.poster_path) ?? null,
          backdropUrl: tmdbPosterUrl(exact?.backdrop_path) ?? null,
        },
      },
    )
  }
  for (const [position, trailer] of filmTrailers(data, normalized).entries())
    await observeCatalogOccurrence(
      tx,
      { kind: 'subscription-item', id: trailer.id },
      {
        ...origin,
        relationshipRole: 'trailer',
        occurrenceKey: JSON.stringify([origin.occurrenceKey, 'trailer']),
        position,
        details: { official: trailer.official },
      },
    )
  if (origin.provider === 'tmdb')
    for (const company of withPosition(
      data['production_companies'],
      TmdbNamedId,
    ))
      await observeCatalogOccurrence(
        tx,
        { kind: 'tmdb-company', id: company.id },
        {
          ...origin,
          relationshipRole: 'production-company',
          occurrenceKey: JSON.stringify([
            origin.occurrenceKey,
            'production-company',
          ]),
          position: company.position,
          details: { name: company.name },
        },
      )
}

export async function observeTmdbFilmResponse(
  tx: Transaction,
  payload: JsonValue,
  endpoint: 'find' | 'search',
  origin: CatalogOrigin,
) {
  const candidates = tmdbFilmCandidates(
    payload,
    endpoint === 'find' ? 'movie_results' : 'results',
  )
  const moviePage = isJsonRecord(payload) ? payload['page'] : null
  const page =
    typeof moviePage === 'number' &&
    Number.isSafeInteger(moviePage) &&
    moviePage > 0
      ? moviePage
      : undefined
  for (const item of candidates)
    await observeFilmCandidate(
      tx,
      {
        externalId: item.id,
        referenceType: 'tmdb',
        title: item.title,
        releaseDate: item.release_date,
        artworkUrl: tmdbPosterUrl(item.poster_path),
      },
      {
        ...origin,
        position: item.position + 1,
        page,
        details: {
          originalTitle: item.original_title ?? null,
          tmdbId: item.id,
        },
      },
    )
  return candidates.length
}
