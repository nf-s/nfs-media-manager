import { createHash } from 'node:crypto'
import { z } from 'zod'

export const LASTFM_API_ROOT = 'https://ws.audioscrobbler.com/2.0/'

/** One play as `track.scrobble` takes it. */
export interface LastfmScrobble {
  artist: string
  track: string
  /** Empty when the album is not known. */
  album: string
  durationMs: number | null
  startedAt: Date
}

/**
 * The `api_sig` of a signed call: every parameter except `format` and
 * `callback`, ordered by name, written as name then value, followed by the
 * shared secret, as the MD5 of its UTF-8 bytes.
 */
export function lastfmSignature(
  params: Record<string, string>,
  secret: string,
): string {
  const text = Object.entries(params)
    .filter(([name]) => name !== 'format' && name !== 'callback')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}${value}`)
    .join('')
  return createHash('md5')
    .update(text + secret, 'utf8')
    .digest('hex')
}

/** The form body of a signed call, answered as JSON. */
export function signedLastfmForm(
  params: Record<string, string>,
  secret: string,
): URLSearchParams {
  return new URLSearchParams({
    ...params,
    api_sig: lastfmSignature(params, secret),
    format: 'json',
  })
}

/** Where the account allows the app; Last.fm returns to `callback` with a token. */
export function lastfmAuthorizationUrl(apiKey: string, callback: string) {
  const url = new URL('https://www.last.fm/api/auth/')
  url.search = new URLSearchParams({ api_key: apiKey, cb: callback }).toString()
  return url.toString()
}

/** `track.scrobble` parameters for up to 50 plays, without the signature. */
export function scrobbleParams(
  apiKey: string,
  sessionKey: string,
  scrobbles: readonly LastfmScrobble[],
): Record<string, string> {
  const params: Record<string, string> = {
    method: 'track.scrobble',
    api_key: apiKey,
    sk: sessionKey,
  }
  scrobbles.forEach((scrobble, index) => {
    params[`artist[${index}]`] = scrobble.artist
    params[`track[${index}]`] = scrobble.track
    params[`timestamp[${index}]`] = String(
      Math.floor(scrobble.startedAt.getTime() / 1000),
    )
    if (scrobble.album) params[`album[${index}]`] = scrobble.album
    const seconds =
      scrobble.durationMs === null ? 0 : Math.round(scrobble.durationMs / 1000)
    if (seconds > 0) params[`duration[${index}]`] = String(seconds)
  })
  return params
}

const ErrorSchema = z.object({ error: z.number().int() })

/** Last.fm's error number, which it may send with HTTP 200 or an error status. */
export function lastfmErrorNumber(body: unknown): number | null {
  const parsed = ErrorSchema.safeParse(body)
  return parsed.success ? parsed.data.error : null
}

/**
 * What a Last.fm error means for a signed call. `session`: the account's
 * sign-in or token was refused, so it must sign in again. `denied`: the API
 * key was refused, as the album and history requests classify it.
 * `temporary`: Last.fm could not answer now. `failed`: anything else,
 * including a wrong shared secret.
 */
export type LastfmFailure =
  | 'session'
  | 'rate-limit'
  | 'temporary'
  | 'denied'
  | 'failed'

export function lastfmFailure(error: number): LastfmFailure {
  // Authentication failed, invalid session key, token not authorized or expired.
  if ([4, 9, 14, 15].includes(error)) return 'session'
  if (error === 29) return 'rate-limit'
  // Operation failed, service offline, temporary error.
  if ([8, 11, 16].includes(error)) return 'temporary'
  // Invalid or suspended API key.
  if ([10, 26].includes(error)) return 'denied'
  return 'failed'
}

const SessionAnswerSchema = z.object({
  session: z.object({ name: z.string().min(1), key: z.string().min(1) }),
})

/** The account name and session key from an `auth.getSession` answer. */
export function parseLastfmSession(body: unknown) {
  const parsed = SessionAnswerSchema.safeParse(body)
  return parsed.success
    ? { name: parsed.data.session.name, sessionKey: parsed.data.session.key }
    : null
}

const CountSchema = z.coerce.number().int().nonnegative()
const EntrySchema = z.object({
  ignoredMessage: z.object({ code: CountSchema }),
})
const ScrobbleAnswerSchema = z.object({
  scrobbles: z.object({
    '@attr': z.object({ accepted: CountSchema, ignored: CountSchema }),
    // One scrobble is answered as an object rather than an array.
    scrobble: z.union([z.array(EntrySchema), EntrySchema]),
  }),
})

/**
 * Last.fm's ignored code for each submitted play, in order: 0 when it was
 * scrobbled. Null when the body is not a scrobble answer. An answer whose
 * entries do not line up with the plays counts every play as scrobbled:
 * Last.fm took the request, and sending it again could duplicate scrobbles.
 */
export function parseScrobbleAnswer(
  body: unknown,
  count: number,
): number[] | null {
  const parsed = ScrobbleAnswerSchema.safeParse(body)
  if (!parsed.success) return null
  const { scrobble } = parsed.data.scrobbles
  const entries = Array.isArray(scrobble) ? scrobble : [scrobble]
  if (entries.length !== count) return Array.from({ length: count }, () => 0)
  return entries.map((entry) => entry.ignoredMessage.code)
}
