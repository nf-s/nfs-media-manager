import { JsonValueSchema, type JsonValue } from './common'

const measurements = new Set([
  'acousticness',
  'danceability',
  'energy',
  'instrumentalness',
  'liveness',
  'loudness',
  'speechiness',
  'tempo',
  'valence',
  'time_signature',
  'timeSignature',
  'analysis_url',
  'analysisUrl',
])
const containers = new Set([
  'audioFeatures',
  'audio_features',
  'audio-features',
])
const musicRecords = new Set([
  'browse',
  'metadata',
  'spotify',
  'tracks',
  'track',
  'items',
  'albums',
  'album',
  'mediaPatch',
  'albumPatch',
  'payload',
  'normalized',
  'normalizedData',
])

export function isSpotifyAudioFeatureKey(key: string): boolean {
  return (
    measurements.has(key) ||
    containers.has(key) ||
    key === 'mode' ||
    key === 'key'
  )
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Only call for music documents. Ambiguous numeric mode/key need music context. */
export function removeSpotifyAudioFeatures(
  input: unknown,
  musicRecord = true,
): {
  value: JsonValue
  removed: Record<string, number>
  changed: boolean
} {
  const source = JsonValueSchema.parse(input)
  const removed: Record<string, number> = {}
  const count = (key: string) => {
    removed[key] = (removed[key] ?? 0) + 1
  }
  function visit(value: JsonValue, music: boolean, parent?: string): JsonValue {
    if (Array.isArray(value)) {
      return value.flatMap((entry) => {
        if (
          (parent === 'filters' || parent === 'ranges') &&
          isRecord(entry) &&
          typeof entry.field === 'string' &&
          isSpotifyAudioFeatureKey(entry.field)
        ) {
          count(`filter:${entry.field}`)
          return []
        }
        return [visit(entry, music, parent)]
      })
    }
    if (!isRecord(value)) return value
    const featureRecord =
      value.type === 'audio_features' ||
      Object.keys(value).some((key) => measurements.has(key))
    const result: Record<string, JsonValue> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (
        containers.has(key) ||
        measurements.has(key) ||
        ((key === 'mode' || key === 'key') &&
          (music || featureRecord) &&
          (typeof entry === 'number' || entry === null))
      ) {
        count(key)
        continue
      }
      if (
        key === 'sort' &&
        Array.isArray(entry) &&
        typeof entry[0] === 'string' &&
        isSpotifyAudioFeatureKey(entry[0])
      ) {
        count(`sort:${entry[0]}`)
        continue
      }
      if (
        key === 'sortBy' &&
        typeof entry === 'string' &&
        isSpotifyAudioFeatureKey(entry)
      ) {
        count(`sort:${entry}`)
        result.sortBy = 'dateAdded'
        continue
      }
      Object.defineProperty(result, key, {
        value: visit(
          entry,
          musicRecords.has(key) ||
            parent === 'albums' ||
            parent === 'tracks' ||
            parent === 'items',
          key,
        ),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return result
  }
  const value = visit(source, musicRecord)
  return { value, removed, changed: Object.keys(removed).length > 0 }
}
