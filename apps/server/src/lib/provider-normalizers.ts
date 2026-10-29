import type { JsonValue, PluginResult } from '@repo/media-plugin-sdk'

export type JsonRecord = Record<string, JsonValue>

function toJsonArray(value: JsonValue | null | undefined): JsonValue[] {
  return Array.isArray(value) ? value : []
}

function toNonEmptyString(value: JsonValue | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value !== 'N/A'
    ? value
    : null
}

function toStringIdentifier(
  value: JsonValue | null | undefined,
): string | null {
  const stringValue = toNonEmptyString(value)

  if (stringValue) {
    return stringValue
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }

  return null
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

function getNestedString(
  record: JsonRecord | null,
  ...keys: string[]
): string | null {
  let current: JsonValue | null = record

  for (const key of keys) {
    current = getRecordValue(isJsonRecord(current) ? current : null, key)
  }

  return toNonEmptyString(current)
}

function splitCommaList(value: string | null): string[] {
  if (!value) {
    return []
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

export function isJsonRecord(
  value: JsonValue | null | undefined,
): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readJsonString(record: JsonRecord, key: string): string | null {
  return toStringIdentifier(getRecordValue(record, key))
}

export function readJsonArray(record: JsonRecord, key: string): JsonValue[] {
  return toJsonArray(getRecordValue(record, key))
}

export function normalizeOmdbPayload(payload: JsonRecord): PluginResult {
  const field = (native: string, legacy: string) =>
    getNestedString(payload, native) ?? getNestedString(payload, legacy)
  const imdbId = field('imdbID', 'imdbid')
  const imdbUrl =
    getNestedString(payload, 'imdburl') ??
    (imdbId ? `https://www.imdb.com/title/${imdbId}/` : null)

  const browse: JsonRecord = {}
  const ratings = readJsonArray(payload, 'Ratings')
  const rt = ratings.find(
    (value) => isJsonRecord(value) && value['Source'] === 'Rotten Tomatoes',
  )
  for (const [key, value] of Object.entries({
    ratingImdbValue: toNumber(field('imdbRating', 'imdbrating')),
    ratingImdbVotes: toNumber(field('imdbVotes', 'imdbvotes')),
    ratingMetascore: toNumber(field('Metascore', 'metascore')),
    ratingRt: isJsonRecord(rt) ? toNumber(rt['Value']) : null,
  }))
    if (value !== null) browse[key] = value
  for (const [key, value] of Object.entries({
    country: splitCommaList(field('Country', 'country')),
    language: splitCommaList(field('Language', 'language')),
  }))
    if (value.length) browse[key] = value
  const released = field('Released', 'released')
  const releaseTime = released
    ? Date.parse(
        /^\d{2} [A-Za-z]{3} \d{4}$/.test(released)
          ? `${released} UTC`
          : released,
      )
    : NaN
  const releaseDate = Number.isFinite(releaseTime)
    ? new Date(releaseTime).toISOString().slice(0, 10)
    : undefined
  const artwork = field('Poster', 'poster')
  return {
    payload,
    normalized: {
      mediaPatch: {
        title: field('Title', 'title') ?? undefined,
        summary: field('Plot', 'plot') ?? undefined,
        artworkUrl:
          artwork && /^https?:\/\//.test(artwork) ? artwork : undefined,
        releaseDate,
        metadata: { browse },
      },
      filmPatch: {
        runtimeMinutes: toNumber(field('Runtime', 'runtime')) ?? undefined,
        boxOffice: toNumber(field('BoxOffice', 'boxoffice')) ?? undefined,
      },
      references: imdbId
        ? [
            {
              referenceType: 'imdb',
              externalId: imdbId,
              isPrimary: true,
            },
          ]
        : [],
      links: imdbUrl
        ? [
            {
              provider: 'omdb',
              label: 'IMDb',
              url: imdbUrl,
            },
          ]
        : [],
      tags: splitCommaList(field('Genre', 'genres')).map((name) => ({
        name,
        kind: 'genre',
      })),
      credits: [
        ...splitCommaList(field('Director', 'director')).map((name, index) => ({
          name,
          role: 'director',
          billingOrder: index,
        })),
        ...splitCommaList(field('Writer', 'writer')).map((name, index) => ({
          name,
          role: 'writer',
          billingOrder: index,
        })),
        ...splitCommaList(field('Actors', 'actors')).map((name, index) => ({
          name,
          role: 'actor',
          billingOrder: index,
        })),
      ],
      tracks: [],
      playlists: [],
    },
  }
}

export function normalizeTmdbPayload(payload: JsonRecord): PluginResult {
  const tmdbId = readJsonString(payload, 'id')
  const posterPath = getNestedString(payload, 'poster_path')
  const collectionValue = getRecordValue(payload, 'belongs_to_collection')
  const collection = isJsonRecord(collectionValue) ? collectionValue : null
  const browse: JsonRecord = {}
  for (const [key, value] of Object.entries({
    ratingTmdbValue: toNumber(payload['vote_average']),
    ratingTmdbVotes: toNumber(payload['vote_count']),
    popularityTmdb: toNumber(payload['popularity']),
  }))
    if (value !== null) browse[key] = value
  for (const [key, source] of [
    ['country', 'production_countries'],
    ['language', 'spoken_languages'],
    ['productionCompany', 'production_companies'],
  ]) {
    if (!key || !source) continue
    const names = readJsonArray(payload, source).flatMap((value) =>
      isJsonRecord(value) && readJsonString(value, 'name')
        ? [readJsonString(value, 'name') ?? '']
        : [],
    )
    if (names.length) browse[key] = names
  }
  const credits = isJsonRecord(payload['credits']) ? payload['credits'] : {}
  const imdbId = readJsonString(payload, 'imdb_id')
  const keywords = isJsonRecord(payload['keywords'])
    ? readJsonArray(payload['keywords'], 'keywords')
    : []
  const keywordTags = keywords.flatMap((value) => {
    if (!isJsonRecord(value)) return []
    const name = getNestedString(value, 'name')
    const id = value['id']
    if (!name || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
      return []
    return [
      {
        name,
        kind: 'keyword',
        source: 'tmdb',
        sourceId: String(id),
        rawName: name,
      },
    ]
  })

  return {
    payload,
    normalized: {
      mediaPatch: {
        title: getNestedString(payload, 'title') ?? undefined,
        originalTitle: getNestedString(payload, 'original_title') ?? undefined,
        summary: getNestedString(payload, 'overview') ?? undefined,
        artworkUrl: posterPath
          ? `https://image.tmdb.org/t/p/w500${posterPath}`
          : undefined,
        releaseDate: getNestedString(payload, 'release_date') ?? undefined,
        metadata: { browse },
      },
      filmPatch: {
        runtimeMinutes:
          toNumber(getRecordValue(payload, 'runtime')) ?? undefined,
        budget: toNumber(getRecordValue(payload, 'budget')) ?? undefined,
        boxOffice: toNumber(getRecordValue(payload, 'revenue')) ?? undefined,
      },
      references: [
        ...(tmdbId
          ? [
              {
                referenceType: 'tmdb',
                externalId: tmdbId,
                isPrimary: true,
              },
            ]
          : []),
        ...(imdbId && /^tt\d+$/.test(imdbId)
          ? [{ referenceType: 'imdb', externalId: imdbId, isPrimary: false }]
          : []),
      ],
      links: tmdbId
        ? [
            {
              provider: 'tmdb',
              label: 'TMDb',
              url: `https://www.themoviedb.org/movie/${tmdbId}`,
            },
          ]
        : [],
      tags: [
        ...toJsonArray(getRecordValue(payload, 'genres')).flatMap(
          (genreValue) => {
            if (!isJsonRecord(genreValue)) {
              return []
            }

            const name = getNestedString(genreValue, 'name')

            if (!name) {
              return []
            }

            const id = genreValue['id']
            return [
              {
                name,
                kind: 'genre',
                source: 'tmdb',
                rawName: name,
                ...(typeof id === 'number' && Number.isSafeInteger(id) && id > 0
                  ? { sourceId: String(id) }
                  : {}),
              },
            ]
          },
        ),
        ...keywordTags,
      ],
      credits: [
        ...readJsonArray(credits, 'cast').flatMap((value, index) => {
          const name = isJsonRecord(value)
            ? readJsonString(value, 'name')
            : null
          return name ? [{ name, role: 'actor', billingOrder: index }] : []
        }),
        ...readJsonArray(credits, 'crew').flatMap((value, index) => {
          if (!isJsonRecord(value)) return []
          const name = readJsonString(value, 'name')
          const job = readJsonString(value, 'job')
          const role =
            job === 'Director'
              ? 'director'
              : job === 'Writer' || job === 'Screenplay' || job === 'Story'
                ? 'writer'
                : null
          return name && role ? [{ name, role, billingOrder: index }] : []
        }),
      ],
      tracks: [],
      playlists: collection
        ? [
            {
              name: getNestedString(collection, 'name') ?? 'Collection',
              kind: 'collection',
              position: 0,
            },
          ]
        : [],
    },
  }
}
