import { and, eq, sql, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { removeSpotifyAudioFeatures } from '@repo/schemas/audio-features'
import { sanitizeAlbumProviderResult } from '@/lib/spotify-audio-features'
import {
  LegacyBrowseRecordSchema,
  normalizeLegacyBrowse,
  mergeLegacyFilmRows,
} from '@/lib/legacy-browse'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  JsonValueSchema,
  PluginResultSchema,
  type JsonValue,
  type MediaProviderPlugin,
  type PluginCredit,
  type PluginNormalizedResult,
  type PluginPlaylist,
  type PluginReference,
  type PluginResult,
  type PluginTag,
  type PluginTrack,
} from '@repo/media-plugin-sdk'
import { db } from '@/lib/db'
import { legacyFilmAddedDate } from '@/lib/film-added-date'
import { env } from '@/env'
import { checksumJson, createStableId, slugifyParts } from '@/lib/media-utils'
import {
  normalizeOmdbPayload,
  normalizeTmdbPayload,
} from '@/lib/provider-normalizers'
import { listLoadedScrapePlugins } from '@/plugins/registry'
import {
  album,
  film,
  mediaItem,
  mediaItemTag,
  playlistItem,
  providerSnapshot,
} from '@/schemas/db'
import { applyProviderResult } from '@/services/provider-state'

export {
  normalizeOmdbPayload,
  normalizeTmdbPayload,
} from '@/lib/provider-normalizers'

type JsonRecord = Record<string, JsonValue>

export interface ImportOptions {
  albumLimit: number | null
  filmLimit: number | null
  onProgress?: (progress: {
    stage: string
    processed: number
    total: number
  }) => Promise<void>
}

interface AlbumBaseRecord {
  id: string
  title: string
  releaseDate: string | null
  artworkUrl: string | null
  sourceLabel: string | null
  metadata: JsonRecord
}

interface FilmBaseRecord {
  id: string
  title: string
  releaseDate: string | null
  artworkUrl: string | null
  summary: string | null
  sourceLabel: string | null
  sourceKind: string | null
  watched: boolean
  runtimeMinutes: number | null
  budget: number | null
  boxOffice: number | null
  metadata: JsonRecord
}

const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url))

function resolveWorkspaceFile(directoryPath: string, filename: string): string {
  if (isAbsolute(directoryPath)) {
    return resolve(directoryPath, filename)
  }

  return resolve(workspaceRoot, directoryPath, filename)
}

function isJsonRecord(
  value: JsonValue | null | undefined,
): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toJsonRecord(value: JsonValue | null | undefined): JsonRecord | null {
  return isJsonRecord(value) ? value : null
}

function toJsonArray(value: JsonValue | null | undefined): JsonValue[] {
  return Array.isArray(value) ? value : []
}

function toNonEmptyString(value: JsonValue | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function toNumber(value: JsonValue | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string') {
    const sanitized = value.replace(/[^0-9.-]/g, '')

    if (sanitized.length === 0) {
      return null
    }

    const parsed = Number(sanitized)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

function toBoolean(value: JsonValue | null | undefined): boolean | null {
  if (typeof value === 'boolean') {
    return value
  }

  if (value === 'true') {
    return true
  }

  if (value === 'false') {
    return false
  }

  return null
}

function getRecordValue(
  record: JsonRecord | null,
  key: string,
): JsonValue | null {
  if (!record) {
    return null
  }

  const value = record[key]

  return typeof value === 'undefined' ? null : value
}

function getNestedRecord(
  record: JsonRecord | null,
  ...keys: string[]
): JsonRecord | null {
  let current: JsonValue | null = record

  for (const key of keys) {
    current = getRecordValue(toJsonRecord(current), key)
  }

  return toJsonRecord(current)
}

function getNestedString(
  record: JsonRecord | null,
  ...keys: string[]
): string | null {
  let current: JsonValue | null = record

  for (const key of keys) {
    current = getRecordValue(toJsonRecord(current), key)
  }

  return toNonEmptyString(current)
}

function firstArrayString(value: JsonValue | null | undefined): string | null {
  for (const item of toJsonArray(value)) {
    const stringValue = toNonEmptyString(item)

    if (stringValue) {
      return stringValue
    }
  }

  return null
}

function createMediaId(mediaType: 'album' | 'film', seed: string): string {
  return createStableId(mediaType, `${mediaType}:${seed}`)
}

function createMediaSlug(title: string, mediaId: string): string {
  return slugifyParts(title, mediaId)
}

function parseArgs(): ImportOptions {
  let albumLimit: number | null = null
  let filmLimit: number | null = null

  for (const argument of process.argv.slice(2)) {
    if (argument.startsWith('--album-limit=')) {
      const parsed = Number(argument.replace('--album-limit=', ''))
      albumLimit =
        Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0
          ? parsed
          : (() => {
              throw new Error('Import limits must be nonnegative integers')
            })()
    }

    if (argument.startsWith('--film-limit=')) {
      const parsed = Number(argument.replace('--film-limit=', ''))
      filmLimit =
        Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0
          ? parsed
          : (() => {
              throw new Error('Import limits must be nonnegative integers')
            })()
    }
  }

  return {
    albumLimit,
    filmLimit,
  }
}

async function readJsonFile(path: string): Promise<JsonValue> {
  const raw = await readFile(path, 'utf8')
  return JsonValueSchema.parse(JSON.parse(raw))
}

async function upsertAlbumBase(record: AlbumBaseRecord): Promise<void> {
  await db
    .insert(mediaItem)
    .values({
      id: record.id,
      mediaType: 'album',
      slug: createMediaSlug(record.title, record.id),
      title: record.title,
      releaseDate: record.releaseDate ? new Date(record.releaseDate) : null,
      artworkUrl: record.artworkUrl,
      sourceLabel: record.sourceLabel,
      metadata: record.metadata,
    })
    .onConflictDoNothing()

  await db
    .insert(album)
    .values({
      mediaItemId: record.id,
      metadata: {},
    })
    .onConflictDoUpdate({
      target: album.mediaItemId,
      set: {
        updatedAt: new Date(),
      },
    })
}

async function upsertFilmBase(record: FilmBaseRecord): Promise<void> {
  await db
    .insert(mediaItem)
    .values({
      id: record.id,
      mediaType: 'film',
      slug: createMediaSlug(record.title, record.id),
      title: record.title,
      summary: record.summary,
      releaseDate: record.releaseDate ? new Date(record.releaseDate) : null,
      artworkUrl: record.artworkUrl,
      sourceLabel: record.sourceLabel,
      metadata: record.metadata,
    })
    .onConflictDoNothing()

  await db
    .insert(film)
    .values({
      mediaItemId: record.id,
      watched: record.watched,
      runtimeMinutes: record.runtimeMinutes,
      sourceKind: record.sourceKind,
      budget: record.budget,
      boxOffice: record.boxOffice,
      metadata: {},
    })
    .onConflictDoNothing()
}

function getImageUrl(
  imagesValue: JsonValue | null,
  preferredHeight: number,
): string | null {
  const images = toJsonArray(imagesValue)
  const matchingImage = images.find((item) => {
    const image = toJsonRecord(item)
    return toNumber(getRecordValue(image, 'height')) === preferredHeight
  })

  if (matchingImage) {
    return getNestedString(toJsonRecord(matchingImage), 'url')
  }

  const firstImage = toJsonRecord(images[0] ?? null)
  return getNestedString(firstImage, 'url')
}

export function normalizeSpotifyAlbum(
  rawAlbum: JsonRecord,
  playlistLibrary: JsonRecord | null,
): PluginResult {
  const spotifyRecord = getNestedRecord(rawAlbum, 'spotify') ?? rawAlbum
  const artists = toJsonArray(getRecordValue(spotifyRecord, 'artists'))
  const tracksContainer = toJsonRecord(getRecordValue(spotifyRecord, 'tracks'))
  const trackItems = toJsonArray(getRecordValue(tracksContainer, 'items'))
  const externalIds = toJsonRecord(
    getRecordValue(spotifyRecord, 'external_ids'),
  )
  const externalUrls = toJsonRecord(
    getRecordValue(spotifyRecord, 'external_urls'),
  )
  const source = toJsonRecord(getRecordValue(rawAlbum, 'source'))
  const playlistIds = toJsonArray(getRecordValue(rawAlbum, 'playlists'))

  const credits: PluginCredit[] = artists.flatMap((artistValue, index) => {
    const artistRecord = toJsonRecord(artistValue)
    const artistName = getNestedString(artistRecord, 'name')

    if (!artistName) {
      return []
    }

    return [
      {
        name: artistName,
        role: 'artist',
        billingOrder: index,
      },
    ]
  })

  const tracks: PluginTrack[] = trackItems.flatMap((trackValue, index) => {
    const trackRecord = toJsonRecord(trackValue)
    const title = getNestedString(trackRecord, 'name')

    if (!title) {
      return []
    }

    return [
      {
        externalId: getNestedString(trackRecord, 'id') ?? undefined,
        title,
        position: index + 1,
        durationSec:
          (toNumber(getRecordValue(trackRecord, 'duration_ms')) ?? 0) > 0
            ? Math.round(
                (toNumber(getRecordValue(trackRecord, 'duration_ms')) ?? 0) /
                  1000,
              )
            : undefined,
      },
    ]
  })

  const playlists: PluginPlaylist[] = playlistIds.flatMap(
    (playlistIdValue, index) => {
      const playlistId = toNonEmptyString(playlistIdValue)

      if (!playlistId || !playlistLibrary) {
        return []
      }

      const playlistRecord = toJsonRecord(
        getRecordValue(playlistLibrary, playlistId),
      )
      const playlistName = getNestedString(playlistRecord, 'name')

      if (!playlistName) {
        return []
      }

      return [
        {
          name: playlistName,
          kind: 'playlist',
          position: index,
        },
      ]
    },
  )

  const references: PluginReference[] = []
  const spotifyId = getNestedString(spotifyRecord, 'id')

  if (spotifyId) {
    references.push({
      referenceType: 'album',
      externalId: spotifyId,
      isPrimary: true,
    })
  }

  const upc = getNestedString(externalIds, 'upc')
  if (upc) {
    references.push({
      referenceType: 'upc',
      externalId: upc,
      isPrimary: false,
    })
  }

  const normalized: PluginNormalizedResult = {
    mediaPatch: {
      title: getNestedString(spotifyRecord, 'name') ?? undefined,
      artworkUrl:
        getImageUrl(getRecordValue(spotifyRecord, 'images'), 300) ?? undefined,
      releaseDate: getNestedString(spotifyRecord, 'release_date') ?? undefined,
      sourceLabel: getNestedString(source, 'type') ?? undefined,
    },
    albumPatch: {
      dateAdded: getNestedString(rawAlbum, 'addedDate') ?? undefined,
      durationSec:
        tracks.length > 0
          ? tracks.reduce((total, track) => total + (track.durationSec ?? 0), 0)
          : undefined,
      spotifyUrl: getNestedString(externalUrls, 'spotify') ?? undefined,
    },
    references,
    links: getNestedString(externalUrls, 'spotify')
      ? [
          {
            provider: 'spotify',
            label: 'Spotify',
            url: getNestedString(externalUrls, 'spotify') ?? '',
          },
        ]
      : [],
    tags: toJsonArray(getRecordValue(spotifyRecord, 'genres')).flatMap(
      (genre) => {
        const name = toNonEmptyString(genre)

        if (!name) {
          return []
        }

        return [{ name, kind: 'genre' }]
      },
    ),
    credits,
    tracks,
    playlists,
  }

  return sanitizeAlbumProviderResult(rawAlbum, normalized)
}

export function normalizeMusicBrainzPayload(payload: JsonRecord): PluginResult {
  const releaseGroup = getNestedRecord(payload, 'releaseGroup')
  const artistCredits = toJsonArray(
    getRecordValue(releaseGroup, 'artist-credit'),
  )
  const genres = toJsonArray(getRecordValue(releaseGroup, 'genres'))
  const releaseGroupId = getNestedString(releaseGroup, 'id')

  return {
    payload,
    normalized: {
      mediaPatch: {
        title: getNestedString(releaseGroup, 'title') ?? undefined,
      },
      references: releaseGroupId
        ? [
            {
              referenceType: 'release-group',
              externalId: releaseGroupId,
              isPrimary: true,
            },
          ]
        : [],
      links: releaseGroupId
        ? [
            {
              provider: 'musicbrainz',
              label: 'MusicBrainz',
              url: `https://musicbrainz.org/release-group/${releaseGroupId}`,
            },
          ]
        : [],
      tags: genres.flatMap((genreValue) => {
        const genre = toJsonRecord(genreValue)
        const name = getNestedString(genre, 'name')

        if (!name) {
          return []
        }

        return [{ name, kind: 'genre' }]
      }),
      credits: artistCredits.flatMap((creditValue, index) => {
        const credit = toJsonRecord(creditValue)
        const artistRecord = getNestedRecord(credit, 'artist')
        const name = getNestedString(artistRecord, 'name')

        if (!name) {
          return []
        }

        return [
          {
            name,
            role: 'artist',
            billingOrder: index,
          },
        ]
      }),
      tracks: [],
      playlists: [],
    },
  }
}

export function normalizeDiscogsPayload(payload: JsonRecord): PluginResult {
  const master = getNestedRecord(payload, 'master')
  const release = getNestedRecord(payload, 'release')
  const current = master ?? release
  const artists = toJsonArray(getRecordValue(current, 'artists'))
  const genres = toJsonArray(getRecordValue(current, 'genres'))
  const styles = toJsonArray(getRecordValue(current, 'styles'))
  const identifier = toNumber(getRecordValue(current, 'id'))
  const uri = getNestedString(current, 'uri')

  return {
    payload,
    normalized: {
      mediaPatch: {
        title: getNestedString(current, 'title') ?? undefined,
      },
      references: identifier
        ? [
            {
              referenceType: master ? 'master' : 'release',
              externalId: String(identifier),
              isPrimary: true,
            },
          ]
        : [],
      links: uri
        ? [
            {
              provider: 'discogs',
              label: 'Discogs',
              url: uri,
            },
          ]
        : [],
      tags: [...genres, ...styles].flatMap((value) => {
        const name = toNonEmptyString(value)

        if (!name) {
          return []
        }

        return [{ name, kind: 'genre' }]
      }),
      credits: artists.flatMap((artistValue, index) => {
        const artistRecord = toJsonRecord(artistValue)
        const name = getNestedString(artistRecord, 'name')

        if (!name) {
          return []
        }

        return [
          {
            name,
            role: 'artist',
            billingOrder: index,
          },
        ]
      }),
      tracks: [],
      playlists: [],
    },
  }
}

export function normalizeLastFmPayload(payload: JsonRecord): PluginResult {
  const tags = getNestedRecord(payload, 'tags')
  const tagList = toJsonArray(getRecordValue(tags, 'tag'))
  const mbid = getNestedString(payload, 'mbid')
  const url = getNestedString(payload, 'url')

  return {
    payload,
    normalized: {
      references: mbid
        ? [
            {
              referenceType: 'mbid',
              externalId: mbid,
              isPrimary: false,
            },
          ]
        : [],
      links: url
        ? [
            {
              provider: 'lastfm',
              label: 'Last.fm',
              url,
            },
          ]
        : [],
      tags: tagList.flatMap((tagValue) => {
        const tagRecord = toJsonRecord(tagValue)
        const name = getNestedString(tagRecord, 'name')

        if (!name) {
          return []
        }

        return [{ name, kind: 'genre' }]
      }),
      credits: [],
      tracks: [],
      playlists: [],
    },
  }
}

export function normalizeGoogleSearchPayload(
  record: JsonRecord,
): PluginResult | null {
  const rymGoogle = getNestedRecord(record, 'rymGoogle')
  const metacriticGoogle = getNestedRecord(record, 'metacriticGoogle')

  if (!rymGoogle && !metacriticGoogle) {
    return null
  }

  const tags: PluginTag[] = toJsonArray(
    getRecordValue(rymGoogle, 'genres'),
  ).flatMap((genreValue) => {
    const name = toNonEmptyString(genreValue)

    if (!name) {
      return []
    }

    return [{ name, kind: 'genre' }]
  })

  const links = [
    rymGoogle
      ? {
          provider: 'google-custom-search',
          label: 'RYM / Sonemic',
          url: getNestedString(rymGoogle, 'link'),
        }
      : null,
    metacriticGoogle
      ? {
          provider: 'google-custom-search',
          label: 'Metacritic',
          url: getNestedString(metacriticGoogle, 'link'),
        }
      : null,
  ].flatMap((item) => {
    if (!item?.url) {
      return []
    }

    return [
      {
        provider: item.provider,
        label: item.label,
        url: item.url,
      },
    ]
  })

  return {
    payload: {
      rymGoogle: rymGoogle ?? null,
      metacriticGoogle: metacriticGoogle ?? null,
    },
    normalized: {
      tags,
      links,
      references: [],
      credits: [],
      tracks: [],
      playlists: [],
    },
  }
}

function deriveAlbumBase(rawAlbum: JsonRecord): AlbumBaseRecord | null {
  const spotify = getNestedRecord(rawAlbum, 'spotify')
  const spotifyId = getNestedString(spotify, 'id')
  const title = getNestedString(spotify, 'name')

  if (!spotifyId || !title) {
    return null
  }

  return {
    id: createMediaId('album', `spotify:${spotifyId}`),
    title,
    releaseDate: getNestedString(spotify, 'release_date'),
    artworkUrl: getImageUrl(getRecordValue(spotify, 'images'), 300),
    sourceLabel: getNestedString(getNestedRecord(rawAlbum, 'source'), 'type'),
    metadata: {
      legacyImport: 'music',
      spotifyId,
    },
  }
}

function getRawMovieTitle(rawMovieContainer: JsonRecord | null): string | null {
  return firstArrayString(getRecordValue(rawMovieContainer, 'title'))
}

function getRawMoviePlot(rawMovieContainer: JsonRecord | null): string | null {
  return firstArrayString(getRecordValue(rawMovieContainer, 'plot'))
}

function getRawMovieReleaseDate(
  rawMovieContainer: JsonRecord | null,
): string | null {
  return (
    firstArrayString(getRecordValue(rawMovieContainer, 'premiered')) ??
    firstArrayString(getRecordValue(rawMovieContainer, 'year'))
  )
}

function getRawMoviePoster(
  rawMovieContainer: JsonRecord | null,
): string | null {
  const thumbs = toJsonArray(getRecordValue(rawMovieContainer, 'thumb'))

  for (const thumbValue of thumbs) {
    const thumb = toJsonRecord(thumbValue)
    const aspect = getNestedString(getNestedRecord(thumb, '$'), 'aspect')

    if (aspect === 'poster') {
      return getNestedString(thumb, '_')
    }
  }

  return firstArrayString(getRecordValue(rawMovieContainer, 'thumb'))
}

function getRuntimeFromRawMovie(
  rawMovieContainer: JsonRecord | null,
): number | null {
  const fileInfo = toJsonArray(getRecordValue(rawMovieContainer, 'fileinfo'))
  const firstFileInfo = toJsonRecord(fileInfo[0] ?? null)
  const streamDetails = toJsonArray(
    getRecordValue(firstFileInfo, 'streamdetails'),
  )
  const firstStreamDetails = toJsonRecord(streamDetails[0] ?? null)
  const videos = toJsonArray(getRecordValue(firstStreamDetails, 'video'))
  const firstVideo = toJsonRecord(videos[0] ?? null)
  const secondsString = firstArrayString(
    getRecordValue(firstVideo, 'durationinseconds'),
  )
  const seconds = toNumber(secondsString)

  if (!seconds) {
    return null
  }

  return Math.round(seconds / 60)
}

function deriveMovieSourceKind(rawMovie: JsonRecord): string | null {
  const owned = getNestedRecord(rawMovie, 'owned')
  const imdbState = getNestedRecord(rawMovie, 'imdb')

  if (getNestedString(owned, 'type') === 'bluray') {
    return 'bluray'
  }

  if (getNestedRecord(rawMovie, 'raw')) {
    return 'file'
  }

  if (getNestedRecord(imdbState, 'myRating')) {
    return 'imdb-rating'
  }

  if (getNestedRecord(imdbState, 'myWatchlist')) {
    return 'imdb-watchlist'
  }

  return null
}

function humanizeSourceKind(sourceKind: string | null): string | null {
  switch (sourceKind) {
    case 'bluray':
      return 'Blu-ray'
    case 'file':
      return 'File'
    case 'imdb-rating':
      return 'IMDb Rating'
    case 'imdb-watchlist':
      return 'IMDb Watchlist'
    default:
      return null
  }
}

function deriveFilmBase(
  rawMovie: JsonRecord,
  sourceKey: string,
): FilmBaseRecord | null {
  const rawContainer = getNestedRecord(
    getNestedRecord(rawMovie, 'raw'),
    'movie',
  )
  const omdb = getNestedRecord(rawMovie, 'omdb')
  const tmdb = getNestedRecord(rawMovie, 'tmdb')
  const ids = getNestedRecord(rawMovie, 'id')

  const imdbId =
    getNestedString(ids, 'imdb') ??
    getNestedString(omdb, 'imdbid') ??
    firstArrayString(getRecordValue(rawContainer, 'id'))
  const tmdbId = getNestedString(ids, 'tmdb') ?? getNestedString(tmdb, 'id')
  const title =
    toNonEmptyString(getRecordValue(rawMovie, 'title')) ??
    getNestedString(omdb, 'title') ??
    getNestedString(tmdb, 'title') ??
    getRawMovieTitle(rawContainer)

  if (!title) {
    return null
  }

  const seed = imdbId ?? tmdbId ?? sourceKey
  const sourceKind = deriveMovieSourceKind(rawMovie)
  const watchedFromImdb =
    toJsonRecord(
      getRecordValue(getNestedRecord(rawMovie, 'imdb'), 'myRating'),
    ) !== null
  const watchedFromRaw =
    toBoolean(firstArrayString(getRecordValue(rawContainer, 'watched'))) ??
    false

  return {
    id: createMediaId('film', seed),
    title,
    releaseDate:
      getNestedString(omdb, 'released') ??
      getNestedString(tmdb, 'release_date') ??
      getRawMovieReleaseDate(rawContainer),
    artworkUrl:
      getNestedString(omdb, 'poster') ??
      (getNestedString(tmdb, 'poster_path')
        ? `https://image.tmdb.org/t/p/w500${getNestedString(tmdb, 'poster_path')}`
        : null) ??
      getRawMoviePoster(rawContainer),
    summary:
      getNestedString(omdb, 'plot') ??
      getNestedString(tmdb, 'overview') ??
      getRawMoviePlot(rawContainer),
    sourceLabel: humanizeSourceKind(sourceKind),
    sourceKind,
    watched: watchedFromImdb || watchedFromRaw,
    runtimeMinutes:
      toNumber(getRecordValue(tmdb, 'runtime')) ??
      toNumber(getNestedString(omdb, 'runtime')) ??
      getRuntimeFromRawMovie(rawContainer),
    budget: toNumber(getRecordValue(tmdb, 'budget')),
    boxOffice:
      toNumber(getRecordValue(tmdb, 'revenue')) ??
      toNumber(getNestedString(omdb, 'boxoffice')),
    metadata: {
      legacyImport: 'film',
      imdbId: imdbId ?? null,
      tmdbId: tmdbId ?? null,
    },
  }
}

export function normalizeNfoPayload(rawMovie: JsonRecord): PluginResult | null {
  const movie = getNestedRecord(getNestedRecord(rawMovie, 'raw'), 'movie')

  if (!movie) {
    return null
  }

  const uniqueIds = toJsonArray(getRecordValue(movie, 'uniqueid'))
  const references: PluginReference[] = uniqueIds.flatMap((uniqueIdValue) => {
    const uniqueId = toJsonRecord(uniqueIdValue)
    const value = getNestedString(uniqueId, '_')
    const type = getNestedString(getNestedRecord(uniqueId, '$'), 'type')

    if (!value || !type) {
      return []
    }

    return [
      {
        referenceType: type,
        externalId: value,
        isPrimary:
          getNestedString(getNestedRecord(uniqueId, '$'), 'default') === 'true',
      },
    ]
  })

  const imdbId = firstArrayString(getRecordValue(movie, 'id'))
  const links =
    imdbId !== null
      ? [
          {
            provider: 'nfo',
            label: 'IMDb',
            url: `https://www.imdb.com/title/${imdbId}/`,
          },
        ]
      : []

  return {
    payload: getNestedRecord(rawMovie, 'raw') ?? {},
    normalized: {
      mediaPatch: {
        title: getRawMovieTitle(movie) ?? undefined,
        summary: getRawMoviePlot(movie) ?? undefined,
        artworkUrl: getRawMoviePoster(movie) ?? undefined,
        releaseDate: getRawMovieReleaseDate(movie) ?? undefined,
      },
      filmPatch: {
        ...legacyFilmAddedDate(rawMovie),
        watched:
          toBoolean(firstArrayString(getRecordValue(movie, 'watched'))) ??
          undefined,
        runtimeMinutes: getRuntimeFromRawMovie(movie) ?? undefined,
        sourceKind: 'file',
      },
      references,
      links,
      tags: [],
      credits: [],
      tracks: [],
      playlists: [],
    },
  }
}

export function normalizeImdbPersonalPayload(
  rawMovie: JsonRecord,
): PluginResult | null {
  const imdbState = getNestedRecord(rawMovie, 'imdb')

  if (!imdbState) {
    return null
  }

  const myRating = getNestedRecord(imdbState, 'myRating')
  const myWatchlist = getNestedRecord(imdbState, 'myWatchlist')

  return {
    payload: imdbState,
    normalized: {
      filmPatch: {
        ...legacyFilmAddedDate(rawMovie),
        watched: myRating !== null ? true : undefined,
        sourceKind:
          myRating !== null
            ? 'imdb-rating'
            : myWatchlist !== null
              ? 'imdb-watchlist'
              : undefined,
      },
      references: [],
      links: [],
      tags: [],
      credits: [],
      tracks: [],
      playlists: [],
    },
  }
}

async function importPluginLegacyResults(
  mediaItemId: string,
  mediaType: 'album' | 'film',
  rawRecord: JsonRecord,
  plugins: MediaProviderPlugin[],
): Promise<void> {
  for (const plugin of plugins) {
    if (!plugin.importLegacyRecord) {
      continue
    }

    if (!plugin.manifest.mediaTypes.includes(mediaType)) {
      continue
    }

    const pluginResult = await plugin.importLegacyRecord({
      rawRecord,
      mediaType,
    })

    if (!pluginResult) {
      continue
    }
    const result = PluginResultSchema.parse(pluginResult)

    await applyProviderResult({
      mediaItemId,
      mediaType,
      provider: plugin.manifest.id,
      source: 'legacy-import',
      payload: result.payload,
      normalized: result.normalized,
    })
  }
}

async function importMusicLibrary(
  plugins: MediaProviderPlugin[],
  options: ImportOptions,
): Promise<void> {
  const musicPath = resolveWorkspaceFile(
    env.LEGACY_SERVER_DATA_DIR,
    'lib-music.json',
  )
  const parsed = await readJsonFile(musicPath)
  const library = toJsonRecord(parsed)
  const albumsRecord = getNestedRecord(library, 'albums')
  const playlistLibrary = getNestedRecord(library, 'playlists')

  if (!albumsRecord) {
    throw new Error('Legacy music library is missing albums.')
  }

  const entries = Object.entries(albumsRecord).slice(
    0,
    options.albumLimit ?? undefined,
  )

  console.info(`Importing ${entries.length} legacy album records`)

  let processed = 0
  for (const [sourceKey, albumValue] of entries) {
    if (processed++ % 25 === 0)
      await options.onProgress?.({
        stage: 'Raw albums',
        processed: processed - 1,
        total: entries.length,
      })
    const rawAlbum = toJsonRecord(removeSpotifyAudioFeatures(albumValue).value)

    if (!rawAlbum) {
      continue
    }

    const base = deriveAlbumBase(rawAlbum)

    if (!base) {
      continue
    }

    await upsertAlbumBase(base)
    await applyProviderResult({
      mediaItemId: base.id,
      mediaType: 'album',
      provider: 'legacy-record',
      source: `legacy-import:${sourceKey}`,
      payload: rawAlbum,
      normalized: PluginResultSchema.parse({ payload: rawAlbum }).normalized,
    })

    const spotify = getNestedRecord(rawAlbum, 'spotify')
    if (spotify) {
      const spotifyResult = normalizeSpotifyAlbum(rawAlbum, playlistLibrary)
      await applyProviderResult({
        mediaItemId: base.id,
        mediaType: 'album',
        provider: 'spotify',
        source: 'legacy-import',
        payload: spotifyResult.payload,
        normalized: spotifyResult.normalized,
      })
    }

    const musicBrainz = getNestedRecord(rawAlbum, 'mb')
    if (musicBrainz) {
      const result = normalizeMusicBrainzPayload(musicBrainz)
      await applyProviderResult({
        mediaItemId: base.id,
        mediaType: 'album',
        provider: 'musicbrainz',
        source: 'legacy-import',
        payload: result.payload,
        normalized: result.normalized,
      })
    }

    const discogs = getNestedRecord(rawAlbum, 'discogs')
    if (discogs) {
      const result = normalizeDiscogsPayload(discogs)
      await applyProviderResult({
        mediaItemId: base.id,
        mediaType: 'album',
        provider: 'discogs',
        source: 'legacy-import',
        payload: result.payload,
        normalized: result.normalized,
      })
    }

    const lastFm = getNestedRecord(rawAlbum, 'lastFm')
    if (lastFm) {
      const result = normalizeLastFmPayload(lastFm)
      await applyProviderResult({
        mediaItemId: base.id,
        mediaType: 'album',
        provider: 'lastfm',
        source: 'legacy-import',
        payload: result.payload,
        normalized: result.normalized,
      })
    }

    const googleResult = normalizeGoogleSearchPayload(rawAlbum)
    if (googleResult) {
      await applyProviderResult({
        mediaItemId: base.id,
        mediaType: 'album',
        provider: 'google-custom-search',
        source: 'legacy-import',
        payload: googleResult.payload,
        normalized: googleResult.normalized,
      })
    }

    await importPluginLegacyResults(base.id, 'album', rawAlbum, plugins)
  }
}

async function importMovieLibrary(
  plugins: MediaProviderPlugin[],
  options: ImportOptions,
): Promise<void> {
  const moviePath = resolveWorkspaceFile(env.LEGACY_SERVER_DATA_DIR, 'lib.json')
  const parsed = await readJsonFile(moviePath)
  const library = toJsonRecord(parsed)
  const moviesRecord = getNestedRecord(library, 'movies')

  if (!moviesRecord) {
    throw new Error('Legacy film library is missing movies.')
  }

  const entries = Object.entries(moviesRecord).slice(
    0,
    options.filmLimit ?? undefined,
  )

  console.info(`Importing ${entries.length} legacy film records`)

  let processed = 0
  for (const [sourceKey, movieValue] of entries) {
    if (processed++ % 25 === 0)
      await options.onProgress?.({
        stage: 'Raw films',
        processed: processed - 1,
        total: entries.length,
      })
    const rawMovie = toJsonRecord(movieValue)

    if (!rawMovie) {
      continue
    }

    const base = deriveFilmBase(rawMovie, sourceKey)

    if (!base) {
      continue
    }

    await upsertFilmBase(base)
    await applyProviderResult({
      mediaItemId: base.id,
      mediaType: 'film',
      provider: 'legacy-record',
      source: `legacy-import:${sourceKey}`,
      payload: rawMovie,
      normalized: PluginResultSchema.parse({
        payload: rawMovie,
        normalized: { filmPatch: legacyFilmAddedDate(rawMovie) },
      }).normalized,
    })

    const nfoResult = normalizeNfoPayload(rawMovie)
    if (nfoResult) {
      await applyProviderResult({
        mediaItemId: base.id,
        mediaType: 'film',
        provider: 'nfo',
        source: 'legacy-import',
        payload: nfoResult.payload,
        normalized: nfoResult.normalized,
      })
    }

    const imdbPersonalResult = normalizeImdbPersonalPayload(rawMovie)
    if (imdbPersonalResult) {
      await applyProviderResult({
        mediaItemId: base.id,
        mediaType: 'film',
        provider: 'imdb-personal',
        source: 'legacy-import',
        payload: imdbPersonalResult.payload,
        normalized: imdbPersonalResult.normalized,
      })
    }

    const omdb = getNestedRecord(rawMovie, 'omdb')
    if (omdb) {
      const result = normalizeOmdbPayload(omdb)
      await applyProviderResult({
        mediaItemId: base.id,
        mediaType: 'film',
        provider: 'omdb',
        source: 'legacy-import',
        payload: result.payload,
        normalized: result.normalized,
      })
    }

    const tmdb = getNestedRecord(rawMovie, 'tmdb')
    if (tmdb) {
      const result = normalizeTmdbPayload(tmdb)
      await applyProviderResult({
        mediaItemId: base.id,
        mediaType: 'film',
        provider: 'tmdb',
        source: 'legacy-import',
        payload: result.payload,
        normalized: result.normalized,
      })
    }

    await importPluginLegacyResults(base.id, 'film', rawMovie, plugins)
  }
}

export async function importCleanLibraries(
  plugins: MediaProviderPlugin[],
  options: ImportOptions,
): Promise<{ albums: number; films: number }> {
  const counts = { albums: 0, films: 0 }
  for (const mediaType of ['album', 'film']) {
    if (mediaType !== 'album' && mediaType !== 'film') continue
    const path = resolveWorkspaceFile(
      'apps/web/public/data',
      mediaType === 'album' ? 'lib-music.json' : 'lib-movie.json',
    )
    const data = await readJsonFile(path)
    const library = toJsonRecord(data)
    const rows =
      mediaType === 'album'
        ? Object.values(getNestedRecord(library, 'albums') ?? {})
        : mergeLegacyFilmRows(toJsonArray(data))
    const playlistNames = Object.fromEntries(
      Object.entries(getNestedRecord(library, 'playlists') ?? {}).flatMap(
        ([id, item]) => {
          const name = getNestedString(toJsonRecord(item), 'name')
          return name ? [[id, name]] : []
        },
      ),
    )
    const limit = mediaType === 'album' ? options.albumLimit : options.filmLimit
    let processed = 0
    const selectedRows = rows.slice(0, limit ?? undefined)
    for (const value of selectedRows) {
      if (processed++ % 25 === 0)
        await options.onProgress?.({
          stage: mediaType === 'album' ? 'Current albums' : 'Current films',
          processed: processed - 1,
          total: selectedRows.length,
        })
      const row = LegacyBrowseRecordSchema.parse(value)
      const externalId =
        mediaType === 'album'
          ? (toNonEmptyString(row.spotifyId) ??
            getNestedString(toJsonRecord(row.id), 'spotify'))
          : toNonEmptyString(row.id)
      if (!externalId)
        throw new Error('Cleaned record is missing its legacy identity')
      const id = createMediaId(
        mediaType,
        mediaType === 'album' ? `spotify:${externalId}` : externalId,
      )
      const result = normalizeLegacyBrowse(row, mediaType, playlistNames)
      await db
        .insert(mediaItem)
        .values({
          id,
          mediaType,
          title: row.title,
          slug: createMediaSlug(row.title, id),
        })
        .onConflictDoNothing()
      if (mediaType === 'album')
        await db.insert(album).values({ mediaItemId: id }).onConflictDoNothing()
      else
        await db.insert(film).values({ mediaItemId: id }).onConflictDoNothing()
      await db.delete(mediaItemTag).where(eq(mediaItemTag.mediaItemId, id))
      await db.delete(playlistItem).where(eq(playlistItem.mediaItemId, id))
      await applyProviderResult({
        mediaItemId: id,
        mediaType,
        provider: 'legacy-browser',
        source: 'legacy-clean-import',
        payload: result.payload,
        normalized: result.normalized,
      })
      await importPluginLegacyResults(id, mediaType, row, plugins)
      if (mediaType === 'album') counts.albums += 1
      else counts.films += 1
    }
  }
  return counts
}

export async function preserveLibraryContext(): Promise<void> {
  const definitionsPath = resolveWorkspaceFile(
    env.LEGACY_SERVER_DATA_DIR,
    'smart-playlists.json',
  )
  if (existsSync(definitionsPath)) {
    const definitions = removeSpotifyAudioFeatures(
      await readJsonFile(definitionsPath),
    ).value
    const checksum = checksumJson(definitions)
    await db
      .insert(providerSnapshot)
      .values({
        id: createStableId('definitions', checksum),
        provider: 'legacy-smart-playlists',
        checksum,
        payload: definitions,
        source: 'legacy-import:smart-playlists.json',
      })
      .onConflictDoNothing()
  }
  for (const filename of ['lib-music.json', 'lib.json']) {
    const library =
      toJsonRecord(
        await readJsonFile(
          resolveWorkspaceFile(env.LEGACY_SERVER_DATA_DIR, filename),
        ),
      ) ?? {}
    const rawContext = Object.fromEntries(
      Object.entries(library).filter(
        ([key]) => key !== 'albums' && key !== 'movies',
      ),
    )
    const context =
      filename === 'lib-music.json'
        ? removeSpotifyAudioFeatures(rawContext).value
        : rawContext
    const checksum = checksumJson(context)
    const id = createStableId('library', `${filename}:${checksum}`)
    await db
      .insert(providerSnapshot)
      .values({
        id,
        provider: 'legacy-library',
        checksum,
        payload: context,
        source: `legacy-import:${filename}`,
      })
      .onConflictDoNothing()
  }
}

export async function reconcileLibraryVisibility(): Promise<void> {
  for (const mediaType of ['album', 'film']) {
    if (mediaType !== 'album' && mediaType !== 'film') continue
    const data = await readJsonFile(
      resolveWorkspaceFile(
        'apps/web/public/data',
        mediaType === 'album' ? 'lib-music.json' : 'lib-movie.json',
      ),
    )
    const rows =
      mediaType === 'album'
        ? Object.values(getNestedRecord(toJsonRecord(data), 'albums') ?? {})
        : toJsonArray(data)
    const ids = rows.map((value) => {
      const row = LegacyBrowseRecordSchema.parse(value)
      const externalId =
        mediaType === 'album'
          ? getNestedString(toJsonRecord(row.id), 'spotify')
          : toNonEmptyString(row.id)
      if (!externalId) throw new Error('Cleaned record is missing its identity')
      return createMediaId(
        mediaType,
        mediaType === 'album' ? `spotify:${externalId}` : externalId,
      )
    })
    if (!ids.length) continue
    await db.transaction(async (tx) => {
      await tx
        .update(mediaItem)
        .set({
          metadata: sql`coalesce(${mediaItem.metadata}, '{}'::jsonb) || '{"legacyHidden":true}'::jsonb`,
        })
        .where(
          and(
            eq(mediaItem.mediaType, mediaType),
            sql`${mediaItem.metadata} ? 'legacyImport'`,
          ),
        )
      await tx
        .update(mediaItem)
        .set({
          metadata: sql`coalesce(${mediaItem.metadata}, '{}'::jsonb) || '{"legacyHidden":false}'::jsonb`,
        })
        .where(inArray(mediaItem.id, ids))
    })
  }
}

export async function runLegacyImport(
  options: ImportOptions,
  onProgress?: ImportOptions['onProgress'],
  lockAlreadyHeld = false,
): Promise<{ albums: number; films: number }> {
  const client = lockAlreadyHeld ? null : await db.$client.connect()
  try {
    if (client) {
      const lock = z
        .object({ rows: z.array(z.object({ locked: z.boolean() })) })
        .parse(
          await client.query('select pg_try_advisory_lock(614103) as locked'),
        )
      if (!lock.rows[0]?.locked)
        throw new Error('Another local library import is running')
    }
    const plugins = await listLoadedScrapePlugins()
    const progressOptions = { ...options, onProgress }
    await importMusicLibrary(plugins, progressOptions)
    await importMovieLibrary(plugins, progressOptions)
    const counts = await importCleanLibraries(plugins, progressOptions)
    await preserveLibraryContext()
    if (options.albumLimit === null && options.filmLimit === null)
      await reconcileLibraryVisibility()
    return counts
  } finally {
    if (client) {
      await client.query('select pg_advisory_unlock(614103)')
      client.release()
    }
  }
}

async function main(): Promise<void> {
  try {
    const result = await runLegacyImport(parseArgs())
    console.info('Legacy import completed.', result)
  } finally {
    await db.$client.end()
  }
}

const isMainModule =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMainModule)
  void main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
