import { XMLParser, XMLValidator } from 'fast-xml-parser'
import {
  JsonValueSchema,
  PluginResultSchema,
  type JsonValue,
  type PluginResult,
} from '@repo/media-plugin-sdk'
import { isJsonRecord, type JsonRecord } from './provider-normalizers'
import { parseOptionalDate } from './media-utils'
import {
  earliestFilmAddedDate,
  filmAddedDate,
  nfoCreationDate,
} from './film-added-date'

const list = (value: JsonValue | undefined): JsonValue[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value]
const text = (value: JsonValue | undefined): string | undefined =>
  typeof value === 'string' && value.trim() && value !== 'N/A'
    ? value.trim()
    : undefined
const number = (value: JsonValue | undefined): number | undefined => {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value.replaceAll(',', ''))
        : NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}
const names = (value: JsonValue | undefined) =>
  list(value).flatMap((item) => (text(item) ? [text(item) ?? ''] : []))
const split = (value: string | undefined) =>
  value
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean) ?? []
const put = (object: JsonRecord, key: string, value: JsonValue | undefined) => {
  if (value !== undefined) object[key] = value
}

export function normalizeImdbCsv(
  row: Record<string, string>,
  format: 'imdb-ratings' | 'imdb-watchlist',
): PluginResult | null {
  const imdb = /^tt\d+$/.test(row['Const']?.trim() ?? '')
    ? row['Const']?.trim()
    : undefined
  const title = row['Title']?.trim()
  if (!title) return null
  if (
    row['Title Type'] &&
    !/^(movie|tv movie|short|documentary|video)$/i.test(row['Title Type'])
  )
    return null
  const browse: JsonRecord = {}
  put(browse, 'ratingImdbValue', number(row['IMDb Rating']))
  put(browse, 'ratingImdbVotes', number(row['Num Votes']))
  const personal = number(row['Your Rating'])
  const hasPersonalRating =
    personal !== undefined && personal >= 1 && personal <= 10
  if (hasPersonalRating) {
    put(browse, 'ratingImdbPersonal', personal)
    put(
      browse,
      'ratingImdbPersonalDate',
      parseOptionalDate(row['Date Rated'])?.getTime(),
    )
  }
  return PluginResultSchema.parse({
    payload: row,
    normalized: {
      mediaPatch: {
        title,
        originalTitle: text(row['Original Title']),
        releaseDate: parseOptionalDate(
          row['Release Date'] || row['Year'],
        )?.toISOString(),
        sourceLabel:
          format === 'imdb-ratings' ? 'IMDb Watched' : 'IMDb Watchlist',
        metadata: {
          browse,
          ...(format === 'imdb-watchlist' ? { watchlist: true } : {}),
        },
      },
      filmPatch: {
        ...earliestFilmAddedDate([
          filmAddedDate(
            row['Created'],
            format === 'imdb-watchlist'
              ? 'IMDb watchlist (estimated)'
              : 'IMDb list (estimated)',
          ),
          filmAddedDate(row['Date Rated'], 'IMDb rating (estimated)'),
        ]),
        watched:
          format === 'imdb-ratings' || hasPersonalRating ? true : undefined,
        sourceKind: format,
        runtimeMinutes: number(row['Runtime (mins)']),
      },
      references: imdb
        ? [{ referenceType: 'imdb', externalId: imdb, isPrimary: true }]
        : [],
      links: imdb
        ? [
            {
              provider: 'imdb-personal',
              label: 'IMDb',
              url: `https://www.imdb.com/title/${imdb}/`,
            },
          ]
        : [],
      tags: split(row['Genres']).map((name) => ({ name, kind: 'genre' })),
      credits: split(row['Directors']).map((name, billingOrder) => ({
        name,
        role: 'director',
        billingOrder,
      })),
    },
  })
}

export function normalizeNfo(
  xml: string,
  file?: { path: string; birthtimeMs: number },
): PluginResult {
  if (
    Buffer.byteLength(xml) > 2 * 1024 * 1024 ||
    /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)
  )
    throw new Error('Unsupported or oversized NFO document')
  // Kodi combined NFO files may append scraper URLs after the XML document.
  const end = xml.lastIndexOf('</movie>') + '</movie>'.length
  const suffix = end >= '</movie>'.length ? xml.slice(end).trim() : ''
  const document =
    suffix &&
    suffix.split(/\r?\n/).every((line) => /^https?:\/\/\S+$/.test(line.trim()))
      ? xml.slice(0, end)
      : xml
  if (XMLValidator.validate(document) !== true)
    throw new Error('Invalid NFO XML')
  const parsed = JsonValueSchema.parse(
    new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: true,
      processEntities: true,
    }).parse(document),
  )
  const movie =
    isJsonRecord(parsed) && isJsonRecord(parsed['movie'])
      ? parsed['movie']
      : null
  if (!movie || !text(movie['title']))
    throw new Error('NFO must contain a movie title')
  const refs = list(movie['uniqueid']).flatMap((value) => {
    if (!isJsonRecord(value)) return []
    const referenceType = text(value['@_type'])
    const externalId = text(value['#text'])
    return externalId &&
      ((referenceType === 'imdb' && /^tt\d+$/.test(externalId)) ||
        (referenceType === 'tmdb' && /^\d+$/.test(externalId)))
      ? [
          {
            referenceType: referenceType ?? '',
            externalId,
            isPrimary: value['@_default'] === 'true',
          },
        ]
      : []
  })
  const imdb = text(movie['imdbid']) ?? text(movie['id'])
  if (
    imdb &&
    /^tt\d+$/.test(imdb) &&
    !refs.some((ref) => ref.referenceType === 'imdb')
  )
    refs.push({ referenceType: 'imdb', externalId: imdb, isPrimary: true })
  const browse: JsonRecord = {}
  for (const [key, value] of Object.entries({
    country: names(movie['country']),
    language: names(movie['language']),
    productionCompany: names(movie['studio']),
  }))
    if (value.length) browse[key] = value
  const ratings = isJsonRecord(movie['ratings'])
    ? list(movie['ratings']['rating'])
    : []
  for (const value of ratings) {
    if (!isJsonRecord(value)) continue
    const source = value['@_name']
    const prefix =
      source === 'imdb' ? 'ratingImdb' : source === 'tmdb' ? 'ratingTmdb' : null
    if (prefix) {
      put(browse, `${prefix}Value`, number(value['value']))
      put(browse, `${prefix}Votes`, number(value['votes']))
    }
  }
  const thumb =
    list(movie['thumb']).find(
      (value) => isJsonRecord(value) && value['@_aspect'] === 'poster',
    ) ?? list(movie['thumb'])[0]
  const artwork = isJsonRecord(thumb) ? text(thumb['#text']) : text(thumb)
  const actors = list(movie['actor']).flatMap((value) =>
    isJsonRecord(value) && text(value['name'])
      ? [text(value['name']) ?? '']
      : [],
  )
  const watched =
    movie['watched'] === 'true' || (number(movie['playcount']) ?? 0) > 0
  return PluginResultSchema.parse({
    payload: parsed,
    normalized: {
      mediaPatch: {
        title: text(movie['title']),
        originalTitle: text(movie['originaltitle']),
        summary: text(movie['plot']),
        artworkUrl:
          artwork && /^https?:\/\//.test(artwork) ? artwork : undefined,
        releaseDate: parseOptionalDate(
          text(movie['premiered']) ?? text(movie['year']),
        )?.toISOString(),
        sourceLabel: 'File',
        metadata: {
          browse,
          ...(file
            ? {
                nfo: {
                  path: file.path,
                  createdAt:
                    nfoCreationDate(file.birthtimeMs)?.dateAdded ?? null,
                },
              }
            : {}),
        },
      },
      filmPatch: {
        ...(file ? nfoCreationDate(file.birthtimeMs) : undefined),
        runtimeMinutes: number(movie['runtime']),
        watched: watched ? true : undefined,
        sourceKind: 'file',
      },
      references: refs,
      tags: names(movie['genre']).map((name) => ({ name, kind: 'genre' })),
      credits: [
        ['director', names(movie['director'])],
        ['writer', names(movie['credits'])],
        ['actor', actors],
      ].flatMap((entry) => {
        const [role, values] = entry
        return typeof role === 'string' && Array.isArray(values)
          ? values.map((name, billingOrder) => ({ name, role, billingOrder }))
          : []
      }),
      playlists:
        isJsonRecord(movie['set']) && text(movie['set']['name'])
          ? [{ name: text(movie['set']['name']), kind: 'collection' }]
          : [],
    },
  })
}
