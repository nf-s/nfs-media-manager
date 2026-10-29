import { z } from 'zod'
import {
  PluginResultSchema,
  JsonValueSchema,
  type JsonValue,
} from '@repo/media-plugin-sdk'
import {
  albumBrowseFields,
  filmBrowseFields,
  BrowseValueSchema,
  type BrowseValues,
} from '@repo/schemas/browse'
import { formatFilmSourceKindValue } from '@repo/schemas/media'
import { filmAddedDate } from './film-added-date'
import { removeSpotifyAudioFeatures } from '@repo/schemas/audio-features'

export const LegacyBrowseRecordSchema = z
  .object({ title: z.string().min(1) })
  .catchall(JsonValueSchema)
export type LegacyBrowseRecord = z.infer<typeof LegacyBrowseRecordSchema>

export function mergeLegacyFilmRows(input: JsonValue[]): LegacyBrowseRecord[] {
  const records = new Map<string, LegacyBrowseRecord>()
  for (const value of input) {
    const row = LegacyBrowseRecordSchema.parse(value)
    const id = z.string().min(1).parse(row.id)
    const previous = records.get(id)
    if (!previous) {
      records.set(id, row)
      continue
    }
    const merged = {
      ...row,
      ...Object.fromEntries(
        Object.entries(previous).filter(([, value]) => value !== null),
      ),
    }
    for (const [key, value] of Object.entries(row)) {
      const earlier = previous[key]
      if (Array.isArray(value) && Array.isArray(earlier))
        merged[key] = [
          ...new Map(
            [...earlier, ...value].map((item) => [JSON.stringify(item), item]),
          ).values(),
        ]
    }
    merged.watched =
      previous.watched === 'Yes' || row.watched === 'Yes' ? 'Yes' : 'No'
    merged.legacyDuplicateRows = [
      ...(Array.isArray(previous.legacyDuplicateRows)
        ? previous.legacyDuplicateRows
        : [previous]),
      row,
    ]
    records.set(id, LegacyBrowseRecordSchema.parse(merged))
  }
  return [...records.values()]
}

const aliases: Record<string, string> = {
  summary: 'description',
  artist: 'artists',
  director: 'directors',
  actor: 'actors',
  writer: 'writers',
  country: 'countries',
  language: 'languages',
  productionCompany: 'productionCompanies',
  collection: 'collections',
  playlist: 'playlists',
  runtimeMinutes: 'runTime',
}
const strings = (value: JsonValue | undefined): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
const text = (value: JsonValue | undefined): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined
const numeric = (value: JsonValue | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const integer = (value: JsonValue | undefined): number | undefined => {
  const n = numeric(value)
  return n !== undefined && n >= 0 ? Math.round(n) : undefined
}
const date = (value: JsonValue | undefined): string | undefined => {
  const n = numeric(value)
  return n !== undefined ? new Date(n).toISOString() : undefined
}
const record = (value: JsonValue | undefined): Record<string, JsonValue> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const safeUrl = (value: JsonValue | undefined): string | undefined => {
  const parsed = z.string().url().safeParse(value)
  return parsed.success && /^https?:\/\//.test(parsed.data)
    ? parsed.data
    : undefined
}

export function normalizeLegacyBrowse(
  row: LegacyBrowseRecord,
  mediaType: 'album' | 'film',
  playlistNames: Record<string, string> = {},
) {
  const browse: BrowseValues = {}
  for (const field of mediaType === 'album'
    ? albumBrowseFields
    : filmBrowseFields) {
    const sourceKey =
      field.key === 'genre'
        ? mediaType === 'album'
          ? 'genres'
          : 'tags'
        : field.key === 'releaseDate' && mediaType === 'album'
          ? 'dateReleased'
          : (aliases[field.key] ?? field.key)
    const value = BrowseValueSchema.safeParse(row[sourceKey])
    if (value.success) {
      const parsedDate =
        field.type === 'date' && typeof value.data === 'string'
          ? Date.parse(value.data)
          : undefined
      browse[field.key] =
        parsedDate !== undefined && Number.isFinite(parsedDate)
          ? parsedDate
          : value.data
    }
  }
  if (mediaType === 'album' && browse.scrobbles === undefined)
    browse.scrobbles = 0
  const linkLabels: Record<string, string> = {
    spotify: 'Spotify',
    imdb: 'IMDb',
    tmdb: 'TMDb',
    rym: 'RYM',
    lastfm: 'Last.fm',
    mb: 'MusicBrainz',
    discogs: 'Discogs',
    mc: 'Metacritic',
  }
  const links = Object.entries(record(row.links)).flatMap(
    ([provider, value]) => {
      const label = linkLabels[provider]
      const url = safeUrl(record(value).href)
      return label && url ? [{ provider, label, url }] : []
    },
  )
  const credits = ['artist', 'director', 'actor', 'writer'].flatMap((role) =>
    strings(row[aliases[role] ?? role]).map((name, billingOrder) => ({
      name,
      role,
      billingOrder,
    })),
  )
  return PluginResultSchema.parse({
    payload:
      mediaType === 'album' ? removeSpotifyAudioFeatures(row).value : row,
    normalized: {
      mediaPatch: {
        title: row.title,
        summary: text(row.description),
        artworkUrl: safeUrl(row.art ?? row.poster),
        releaseDate: date(
          mediaType === 'album' ? row.dateReleased : row.releaseDate,
        ),
        sourceLabel: text(row.source)
          ? formatFilmSourceKindValue(String(row.source))
          : undefined,
        metadata: { browse, legacyBrowse: true, legacyHidden: false },
      },
      albumPatch:
        mediaType === 'album'
          ? {
              dateAdded: date(row.dateAdded),
              durationSec: integer(row.durationSec),
              spotifyUrl: links.find((link) => link.provider === 'spotify')
                ?.url,
            }
          : undefined,
      filmPatch:
        mediaType === 'film'
          ? {
              ...filmAddedDate(row.dateAdded, 'Legacy library date'),
              runtimeMinutes: integer(row.runTime),
              watched: row.watched === 'Yes',
              sourceKind: text(row.source),
              budget: integer(row.budget),
              boxOffice: integer(row.boxOffice),
            }
          : undefined,
      links,
      credits,
      tags: strings(mediaType === 'album' ? row.genres : row.tags).map(
        (name) => ({ name, kind: 'genre' }),
      ),
      playlists: [
        ...strings(row.collections).map((name, position) => ({
          name,
          kind: 'collection',
          position,
        })),
        ...strings(row.playlists).map((id, position) => ({
          name: playlistNames[id] ?? id,
          kind: 'playlist',
          position,
        })),
      ],
    },
  })
}
