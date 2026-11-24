import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  lt,
  lte,
  between,
  isNull,
  or,
  sql,
} from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import {
  ProviderRequestError,
  type MediaPluginTestContext,
} from '@repo/media-plugin-sdk'
import {
  LASTFM_SCROBBLE_BATCH,
  LastfmCallbackQuerySchema,
  LastfmCallbackStateSchema,
  LastfmDisconnectResultSchema,
  LastfmScrobbleInputSchema,
  LastfmScrobbleResultSchema,
  LastfmScrobblingStatusSchema,
  type LastfmPlay,
  type LastfmScrobbleInput,
  type LastfmScrobbleResult,
  type LastfmScrobblingStatus,
} from '@repo/schemas/lastfm'
import { db } from '@/lib/db'
import { env } from '@/env'
import { decryptSecretValue, encryptSecretValue } from '@/lib/crypto'
import { ServerError } from '@/lib/error'
import { albumNameKey } from '@/lib/album-import-candidates'
import { RecentTracksSchema } from '@/lib/lastfm-recent-tracks'
import {
  LASTFM_API_ROOT,
  lastfmAuthorizationUrl,
  lastfmErrorNumber,
  lastfmFailure,
  parseLastfmSession,
  parseScrobbleAnswer,
  scrobbleParams,
  signedLastfmForm,
  type LastfmFailure,
} from '@/lib/lastfm-scrobble-api'
import { resolveProviderSecrets } from '@/lib/provider-secrets'
import { retryAfterTime } from '@/lib/request-policy'
import { LASTFM_USER_AGENT, lastfmPlugin } from '@/plugins/builtin/lastfm'
import { lastfmPlay, providerSecret } from '@/schemas/db'
import {
  clearProviderAccessHalt,
  createDirectProviderRequest,
  recordProviderFailure,
} from './provider-requests'

const StateSchema = z.object({
  stateHash: z.string(),
  sessionHash: z.string(),
  apiKey: z.string(),
  returnOrigin: z.string().url(),
  expiresAt: z.number(),
  consumed: z.boolean().default(false),
})
const SessionSchema = z.object({
  sessionKey: z.string().min(1),
  name: z.string().min(1),
  apiKey: z.string().min(1),
})

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS
const STATE_TTL_MS = 10 * MINUTE_MS
/** Last.fm ignores scrobbles older than this. */
const MAX_AGE_MS = 14 * DAY_MS
const MAX_AHEAD_MS = 5 * MINUTE_MS
const MIN_DUPLICATE_WINDOW_MS = 30 * 1000
/**
 * A start time is read off the room, a second or two out either way, so a
 * track played again straight after itself can seem to start just before the
 * first play ended. The duplicate window stops this short of the track's end.
 */
const REPLAY_MARGIN_MS = 10 * 1000
/** The widest duplicate window, from the longest duration a play may have. */
const MAX_DUPLICATE_WINDOW_MS = DAY_MS
// Advisory lock classes: one for storing a user's plays, one for sending them.
const STORE_LOCK = 72042
const SEND_LOCK = 72043
// Give a service reporting at the end of the track time to reach Last.fm.
const HISTORY_GRACE_MS = MINUTE_MS
const UNKNOWN_LENGTH_MS = 4 * MINUTE_MS
const HISTORY_TOLERANCE_MS = 10_000
// Last.fm sends its error numbers with these statuses; it says whether the
// account or the app was refused, so the caller classifies them.
const ANSWERED_STATUSES = [400, 401, 403]

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const namespace = (userId: string) => `lastfm-account-${hash(userId)}`
type SecretDatabase = Pick<typeof db, 'insert' | 'select' | 'delete' | 'update'>
type Settings = { apiKey: string; apiSecret: string }
type StoredSession = z.infer<typeof SessionSchema> & {
  rowId: string
  encryptedValue: string
}

function unavailable(message: string) {
  return new ServerError({ statusCode: 422, message })
}

async function writeSecret(
  database: SecretDatabase,
  userId: string,
  key: string,
  value: unknown,
) {
  const encryptedValue = encryptSecretValue(JSON.stringify(value))
  await database
    .insert(providerSecret)
    .values({
      id: nanoid(),
      provider: namespace(userId),
      key,
      encryptedValue,
      lastUpdatedByUserId: userId,
    })
    .onConflictDoUpdate({
      target: [providerSecret.provider, providerSecret.key],
      set: {
        encryptedValue,
        lastUpdatedByUserId: userId,
        updatedAt: new Date(),
      },
    })
}

const accountSecret = (userId: string, key: string) =>
  and(
    eq(providerSecret.provider, namespace(userId)),
    eq(providerSecret.key, key),
    eq(providerSecret.lastUpdatedByUserId, userId),
  )

/** The API key and shared secret; null unless both are saved. */
async function settings(): Promise<Settings | null> {
  const rows = await db
    .select()
    .from(providerSecret)
    .where(eq(providerSecret.provider, 'lastfm'))
  const secrets = resolveProviderSecrets(
    'lastfm',
    rows,
    lastfmPlugin.manifest.secrets,
  )
  const apiKey = secrets['apiKey']?.trim()
  const apiSecret = secrets['apiSecret']?.trim()
  return apiKey && apiSecret ? { apiKey, apiSecret } : null
}

async function storedSession(userId: string): Promise<StoredSession | null> {
  const [row] = await db
    .select()
    .from(providerSecret)
    .where(accountSecret(userId, 'session'))
  if (!row) return null
  return {
    ...SessionSchema.parse(JSON.parse(decryptSecretValue(row.encryptedValue))),
    rowId: row.id,
    encryptedValue: row.encryptedValue,
  }
}

/** A session counts only for the API key it was issued for. */
function activeSession(config: Settings | null, session: StoredSession | null) {
  return config && session && session.apiKey === config.apiKey ? session : null
}

export async function getLastfmScrobblingStatus(
  userId: string,
): Promise<LastfmScrobblingStatus> {
  const config = await settings()
  const session = activeSession(config, await storedSession(userId))
  return LastfmScrobblingStatusSchema.parse({
    configured: config !== null,
    connected: session !== null,
    account: session?.name ?? null,
  })
}

function lastfmCallbackUrl(state: string) {
  const destination = new URL(
    `/api/v1/lastfm/scrobbling/callback/${state}`,
    env.AUTH_BASE_URL ?? env.INTERNAL_BACKEND_URL ?? env.APP_URL,
  )
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(
    destination.hostname,
  )
  if (
    destination.username ||
    destination.password ||
    (destination.protocol !== 'https:' &&
      !(destination.protocol === 'http:' && local)) ||
    !env.TRUSTED_ORIGINS.includes(destination.origin)
  )
    throw unavailable('Configure a trusted browser-facing API/auth URL first.')
  return destination
}

export async function authorizeLastfmScrobbling(
  userId: string,
  sessionId: string,
  browserOrigin = new URL(env.APP_URL).origin,
) {
  const config = await settings()
  if (!config)
    throw unavailable(
      'Add the Last.fm API key and shared secret in Providers first.',
    )
  const browser = new URL(browserOrigin)
  if (!env.TRUSTED_ORIGINS.includes(browser.origin))
    throw unavailable('Start Last.fm sign-in from a trusted app origin.')
  // Last.fm adds the token to the callback's query, so the state is in its path.
  const state = randomBytes(32).toString('base64url')
  const callback = lastfmCallbackUrl(state)
  const expiresAt = Date.now() + STATE_TTL_MS
  await writeSecret(db, userId, 'state', {
    stateHash: hash(state),
    sessionHash: hash(sessionId),
    apiKey: config.apiKey,
    returnOrigin: browser.origin,
    expiresAt,
  })
  return {
    url: lastfmAuthorizationUrl(config.apiKey, callback.href),
    expiresAt: new Date(expiresAt).toISOString(),
  }
}

type LastfmAnswer =
  | { ok: true; body: unknown }
  | { ok: false; failure: LastfmFailure | 'unavailable' }

/**
 * Records a failure Last.fm reported for a signed call the way the history
 * sync records it. A refused account sign-in is not the provider's failure.
 */
async function recordLastfmFailure(
  failure: LastfmFailure,
  retryAfter: string | null,
  detail: string,
) {
  if (failure === 'session') return
  await recordProviderFailure(
    lastfmPlugin,
    failure === 'rate-limit'
      ? new ProviderRequestError(
          'Last.fm rate limit reached.',
          'rate-limit',
          retryAfterTime(retryAfter, Date.now(), 60000),
        )
      : failure === 'denied'
        ? new ProviderRequestError(
            'Last.fm refused the API key.',
            'access-denied',
          )
        : new ProviderRequestError(
            failure === 'temporary'
              ? 'Last.fm returned a temporary service error.'
              : detail,
            'request-failed',
          ),
  )
}

/**
 * Sends one signed call as a form POST. A request that never reached Last.fm,
 * or that the provider's state refused, is already recorded and `unavailable`.
 */
async function callLastfm(
  request: MediaPluginTestContext['request'],
  params: Record<string, string>,
  secret: string,
): Promise<LastfmAnswer> {
  let response: Response
  try {
    response = await request(LASTFM_API_ROOT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': LASTFM_USER_AGENT,
      },
      body: signedLastfmForm(params, secret),
    })
  } catch (error) {
    if (error instanceof ProviderRequestError)
      return { ok: false, failure: 'unavailable' }
    throw error
  }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    /* Classified by its HTTP status below. */
  }
  const error = lastfmErrorNumber(body)
  const failure: LastfmFailure | null =
    error !== null
      ? lastfmFailure(error)
      : response.ok
        ? null
        : response.status === 400
          ? 'failed'
          : 'denied'
  if (!failure) return { ok: true, body }
  await recordLastfmFailure(
    failure,
    response.headers.get('retry-after'),
    error === null
      ? `Last.fm request failed (HTTP ${response.status}).`
      : `Last.fm returned a service error (code ${error}).`,
  )
  return { ok: false, failure }
}

export async function finishLastfmScrobbling(
  stateInput: string,
  queryInput: z.input<typeof LastfmCallbackQuerySchema>,
  userId: string,
  sessionId: string,
) {
  const stateValue = LastfmCallbackStateSchema.parse(stateInput)
  const { token } = LastfmCallbackQuerySchema.parse(queryInput)
  const config = await settings()
  const state = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(providerSecret)
      .where(accountSecret(userId, 'state'))
      .for('update')
    if (!row)
      throw unavailable(
        'Last.fm sign-in expired or unavailable. Connect again.',
      )
    const saved = StateSchema.parse(
      JSON.parse(decryptSecretValue(row.encryptedValue)),
    )
    const expected = Buffer.from(saved.stateHash)
    const actual = Buffer.from(hash(stateValue))
    if (
      saved.consumed ||
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual) ||
      saved.sessionHash !== hash(sessionId) ||
      saved.expiresAt <= Date.now() ||
      saved.apiKey !== config?.apiKey
    )
      throw unavailable(
        'Last.fm sign-in expired or does not match this session. Connect again.',
      )
    const encryptedValue = encryptSecretValue(
      JSON.stringify({ ...saved, consumed: true }),
    )
    await tx
      .update(providerSecret)
      .set({ encryptedValue })
      .where(eq(providerSecret.id, row.id))
    return { ...saved, rowId: row.id, encryptedValue, config }
  })
  if (!token) {
    await db
      .delete(providerSecret)
      .where(
        and(
          eq(providerSecret.id, state.rowId),
          eq(providerSecret.encryptedValue, state.encryptedValue),
        ),
      )
    return { connected: false, returnOrigin: state.returnOrigin }
  }
  const answer = await callLastfm(
    createDirectProviderRequest(lastfmPlugin, ANSWERED_STATUSES),
    { method: 'auth.getSession', api_key: state.apiKey, token },
    state.config.apiSecret,
  )
  const session = answer.ok ? parseLastfmSession(answer.body) : null
  if (!session)
    throw unavailable('Last.fm did not confirm the sign-in. Connect again.')
  await db.transaction(async (tx) => {
    const [pending] = await tx
      .select()
      .from(providerSecret)
      .where(
        and(
          eq(providerSecret.id, state.rowId),
          eq(providerSecret.encryptedValue, state.encryptedValue),
        ),
      )
      .for('update')
    if (!pending || state.expiresAt <= Date.now())
      throw unavailable(
        'Last.fm sign-in was disconnected, replaced or expired. Connect again.',
      )
    await writeSecret(tx, userId, 'session', {
      sessionKey: session.sessionKey,
      name: session.name,
      apiKey: state.apiKey,
    })
    await tx.delete(providerSecret).where(eq(providerSecret.id, state.rowId))
  })
  // Last.fm accepted the API key, and a new sign-in is an explicit credential update.
  await clearProviderAccessHalt('lastfm')
  return { connected: true, returnOrigin: state.returnOrigin }
}

/**
 * Deletes the stored session, the pending sign-in and plays still waiting to
 * be sent, which could otherwise go to an account connected later. Sent plays
 * stay to recognise reports of them again.
 */
export async function disconnectLastfmScrobbling(userId: string) {
  await db
    .delete(providerSecret)
    .where(
      and(
        eq(providerSecret.provider, namespace(userId)),
        eq(providerSecret.lastUpdatedByUserId, userId),
      ),
    )
  await db
    .delete(lastfmPlay)
    .where(and(eq(lastfmPlay.userId, userId), eq(lastfmPlay.status, 'waiting')))
  return LastfmDisconnectResultSchema.parse({ disconnected: true })
}

type KnownPlay = Pick<LastfmPlay, 'trackUri' | 'durationMs' | 'startedAt'>

function duplicates(a: KnownPlay, b: KnownPlay) {
  return (
    a.trackUri === b.trackUri &&
    Math.abs(a.startedAt - b.startedAt) <
      Math.max(
        Math.max(a.durationMs ?? 0, b.durationMs ?? 0) - REPLAY_MARGIN_MS,
        MIN_DUPLICATE_WINDOW_MS,
      )
  )
}

/**
 * The reported plays to keep, oldest first: not more than five minutes ahead
 * or fourteen days behind `now`, and not starting within the longer duration
 * less ten seconds (at least 30 seconds) of a known play of the same track or
 * of an earlier one kept from this report.
 */
export function newLastfmPlays(
  plays: readonly LastfmPlay[],
  known: readonly KnownPlay[],
  now: number,
): LastfmPlay[] {
  const seen: KnownPlay[] = [...known]
  const kept: LastfmPlay[] = []
  for (const play of [...plays].sort((a, b) => a.startedAt - b.startedAt)) {
    if (play.startedAt > now + MAX_AHEAD_MS) continue
    if (play.startedAt < now - MAX_AGE_MS) continue
    if (seen.some((other) => duplicates(play, other))) continue
    seen.push(play)
    kept.push(play)
  }
  return kept
}

/**
 * Stores the plays not reported before. Reports from several pages are
 * serialized per user, because a duplicate is a play within a time window of
 * another, which no unique index can express.
 */
async function storePlays(userId: string, plays: readonly LastfmPlay[]) {
  if (!plays.length) return 0
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${STORE_LOCK}, hashtext(${userId}))`,
    )
    const starts = plays.map((play) => play.startedAt)
    const known = await tx
      .select({
        trackUri: lastfmPlay.trackUri,
        durationMs: lastfmPlay.durationMs,
        startedAt: lastfmPlay.startedAt,
      })
      .from(lastfmPlay)
      .where(
        and(
          eq(lastfmPlay.userId, userId),
          inArray(lastfmPlay.trackUri, [
            ...new Set(plays.map((play) => play.trackUri)),
          ]),
          gte(
            lastfmPlay.startedAt,
            new Date(Math.min(...starts) - MAX_DUPLICATE_WINDOW_MS),
          ),
          lte(
            lastfmPlay.startedAt,
            new Date(Math.max(...starts) + MAX_DUPLICATE_WINDOW_MS),
          ),
        ),
      )
    const kept = newLastfmPlays(
      plays,
      known.map((row) => ({ ...row, startedAt: row.startedAt.getTime() })),
      Date.now(),
    )
    if (kept.length)
      await tx.insert(lastfmPlay).values(
        kept.map((play) => ({
          id: nanoid(),
          userId,
          trackUri: play.trackUri,
          artist: play.artist,
          track: play.track,
          album: play.album,
          durationMs: play.durationMs,
          startedAt: new Date(play.startedAt),
        })),
      )
    return kept.length
  })
}

type StoredPlay = typeof lastfmPlay.$inferSelect

function dueForHistory(now: number) {
  return sql`${lastfmPlay.startedAt}
    + (coalesce(nullif(${lastfmPlay.durationMs}, 0), ${UNKNOWN_LENGTH_MS}) + ${HISTORY_GRACE_MS})
      * interval '1 millisecond' <= ${new Date(now).toISOString()}::timestamp`
}

function historyKey(artist: string, title: string, timestamp: number) {
  return JSON.stringify([
    albumNameKey(artist),
    albumNameKey(title),
    Math.floor(timestamp / 1000),
  ])
}

type HistoryEntry = { artist: string; title: string; timestamp: number }

/** Read the whole time range before deciding that a qualifying play is missing. */
async function readPlayHistory(
  request: MediaPluginTestContext['request'],
  config: Settings,
  session: StoredSession,
  from: number,
  to: number,
): Promise<
  { ok: true; entries: HistoryEntry[] } | Extract<LastfmAnswer, { ok: false }>
> {
  const entries: HistoryEntry[] = []
  let expectedPages: number | undefined
  for (let page = 1; ; page++) {
    const answer = await callLastfm(
      request,
      {
        method: 'user.getRecentTracks',
        api_key: config.apiKey,
        sk: session.sessionKey,
        user: session.name,
        from: String(Math.floor(from / 1000) - 1),
        to: String(Math.ceil(to / 1000) + 1),
        limit: '200',
        page: String(page),
      },
      config.apiSecret,
    )
    if (!answer.ok) return answer
    const parsed = RecentTracksSchema.safeParse(answer.body)
    if (!parsed.success) break
    const { track, '@attr': attr } = parsed.data.recenttracks
    const listed = Array.isArray(track) ? track : track ? [track] : []
    expectedPages ??= attr.totalPages
    if (
      (attr.user && attr.user.toLowerCase() !== session.name.toLowerCase()) ||
      (attr.page !== page && !(page === 1 && attr.totalPages === 0)) ||
      attr.totalPages !== expectedPages ||
      (listed.length === 0 && (attr.totalPages > 1 || (attr.total ?? 0) > 0)) ||
      listed.some((item) => !item.date && item['@attr']?.nowplaying !== 'true')
    )
      break
    for (const item of listed)
      if (item.date && item['@attr']?.nowplaying !== 'true')
        entries.push({
          artist: albumNameKey(item.artist['#text']),
          title: albumNameKey(item.name),
          timestamp: item.date.uts * 1000,
        })
    if (page >= expectedPages) return { ok: true, entries }
  }
  await recordLastfmFailure(
    'failed',
    null,
    'Last.fm returned an invalid listening history page.',
  )
  return { ok: false, failure: 'failed' }
}

/** Each dated scrobble can explain one room play, including across retries. */
function matchHistory(
  play: StoredPlay,
  history: HistoryEntry[],
  claimed: Set<string>,
) {
  const start = play.startedAt.getTime()
  const end = start + (play.durationMs ?? 0)
  const artist = albumNameKey(play.artist)
  const title = albumNameKey(play.track)
  let best: HistoryEntry | undefined
  let closest = Infinity
  for (const entry of history) {
    if (
      entry.artist !== artist ||
      entry.title !== title ||
      claimed.has(historyKey(artist, title, entry.timestamp))
    )
      continue
    const startDistance = Math.abs(start - entry.timestamp)
    const endDistance = Math.abs(end - entry.timestamp)
    // A consecutive replay can start at this play's end. Claim a start
    // match first, leaving that boundary for the replay when both exist.
    const distance =
      startDistance <= HISTORY_TOLERANCE_MS
        ? startDistance
        : endDistance <= HISTORY_TOLERANCE_MS
          ? HISTORY_TOLERANCE_MS + 1 + endDistance
          : Infinity
    if (distance < closest) {
      best = entry
      closest = distance
    }
  }
  if (best) claimed.add(historyKey(artist, title, best.timestamp))
  return best
}

/** Check and send one user's due plays under the existing sender lock. */
async function sendWaitingPlays(
  userId: string,
  config: Settings,
  session: StoredSession,
  now: number,
) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${SEND_LOCK}, hashtext(${userId}))`,
    )
    // A scheduled sender can have read the sign-in before a disconnect.
    const [connected] = await tx
      .select({ id: providerSecret.id })
      .from(providerSecret)
      .where(
        and(
          eq(providerSecret.id, session.rowId),
          eq(providerSecret.encryptedValue, session.encryptedValue),
        ),
      )
      .for('update')
    if (!connected) return 0
    const invalidateSession = () =>
      tx.delete(providerSecret).where(eq(providerSecret.id, connected.id))
    await tx
      .update(lastfmPlay)
      .set({ status: 'ignored', ignoredCode: null })
      .where(
        and(
          eq(lastfmPlay.userId, userId),
          eq(lastfmPlay.status, 'waiting'),
          lt(lastfmPlay.startedAt, new Date(now - MAX_AGE_MS)),
        ),
      )
    // Older plays can no longer be reported or sent.
    await tx
      .delete(lastfmPlay)
      .where(
        and(
          eq(lastfmPlay.userId, userId),
          lt(
            lastfmPlay.startedAt,
            new Date(now - MAX_AGE_MS - MAX_DUPLICATE_WINDOW_MS),
          ),
        ),
      )
    const waiting = await tx
      .select()
      .from(lastfmPlay)
      .where(
        and(
          eq(lastfmPlay.userId, userId),
          eq(lastfmPlay.status, 'waiting'),
          dueForHistory(now),
        ),
      )
      .orderBy(asc(lastfmPlay.startedAt), asc(lastfmPlay.id))
    const request = createDirectProviderRequest(lastfmPlugin, ANSWERED_STATUSES)
    let scrobbled = 0
    for (
      let start = 0;
      start < waiting.length;
      start += LASTFM_SCROBBLE_BATCH
    ) {
      const due = waiting.slice(start, start + LASTFM_SCROBBLE_BATCH)
      const from =
        Math.min(...due.map((play) => play.startedAt.getTime())) -
        HISTORY_TOLERANCE_MS
      const to =
        Math.max(
          ...due.map(
            (play) => play.startedAt.getTime() + (play.durationMs ?? 0),
          ),
        ) + HISTORY_TOLERANCE_MS
      const history = await readPlayHistory(request, config, session, from, to)
      if (!history.ok) {
        if (history.failure === 'session') await invalidateSession()
        break
      }
      const previous =
        history.entries.length === 0
          ? []
          : await tx
              .select({
                artist: lastfmPlay.artist,
                title: lastfmPlay.track,
                status: lastfmPlay.status,
                startedAt: lastfmPlay.startedAt,
                sentAt: lastfmPlay.sentAt,
              })
              .from(lastfmPlay)
              .where(
                and(
                  eq(lastfmPlay.userId, userId),
                  or(
                    and(
                      eq(lastfmPlay.status, 'sent'),
                      between(
                        lastfmPlay.startedAt,
                        new Date(from - 1000),
                        new Date(to + 1000),
                      ),
                    ),
                    and(
                      eq(lastfmPlay.status, 'ignored'),
                      isNull(lastfmPlay.ignoredCode),
                      between(lastfmPlay.sentAt, new Date(from), new Date(to)),
                    ),
                  ),
                ),
              )
      const claimed = new Set<string>()
      for (const play of previous) {
        const timestamp = play.status === 'sent' ? play.startedAt : play.sentAt
        if (timestamp)
          claimed.add(historyKey(play.artist, play.title, timestamp.getTime()))
      }
      const batch: StoredPlay[] = []
      for (const play of due) {
        const existing = matchHistory(play, history.entries, claimed)
        if (existing) {
          // A locally skipped play has no provider rejection code. Keep the
          // timestamp Last.fm reported so a replay cannot claim it again.
          await tx
            .update(lastfmPlay)
            .set({
              status: 'ignored',
              ignoredCode: null,
              sentAt: new Date(existing.timestamp),
            })
            .where(eq(lastfmPlay.id, play.id))
        } else batch.push(play)
      }
      if (!batch.length) continue
      const answer = await callLastfm(
        request,
        scrobbleParams(config.apiKey, session.sessionKey, batch),
        config.apiSecret,
      )
      if (!answer.ok) {
        // A refused session asks for a new sign-in; the plays keep waiting.
        if (answer.failure === 'session') await invalidateSession()
        break
      }
      const codes = parseScrobbleAnswer(answer.body, batch.length)
      if (!codes) {
        await recordLastfmFailure(
          'failed',
          null,
          'Last.fm returned an invalid scrobble answer.',
        )
        break
      }
      const sentAt = new Date()
      const byCode = new Map<number, string[]>()
      batch.forEach((play, index) => {
        const code = codes[index] ?? 0
        byCode.set(code, [...(byCode.get(code) ?? []), play.id])
      })
      for (const [code, ids] of byCode)
        await tx
          .update(lastfmPlay)
          .set(
            code === 0
              ? { status: 'sent', sentAt }
              : { status: 'ignored', ignoredCode: code, sentAt },
          )
          .where(inArray(lastfmPlay.id, ids))
      scrobbled += byCode.get(0)?.length ?? 0
    }
    return scrobbled
  })
}

async function waitingCount(userId: string) {
  const [row] = await db
    .select({ waiting: count() })
    .from(lastfmPlay)
    .where(and(eq(lastfmPlay.userId, userId), eq(lastfmPlay.status, 'waiting')))
  return row?.waiting ?? 0
}

/** Finish due room plays even after the last player page closes. */
export async function flushDueLastfmPlays() {
  const now = Date.now()
  const users = await db
    .selectDistinct({ userId: lastfmPlay.userId })
    .from(lastfmPlay)
    .where(and(eq(lastfmPlay.status, 'waiting'), dueForHistory(now)))
  if (!users.length) return
  const config = await settings()
  if (!config) return
  for (const { userId } of users) {
    const session = activeSession(config, await storedSession(userId))
    if (session) await sendWaitingPlays(userId, config, session, now)
  }
}

/**
 * Queues new plays and checks eligible plays against the connected account.
 * A failed history read or send leaves plays waiting for a later check.
 */
export async function scrobbleLastfmPlays(
  userId: string,
  input: LastfmScrobbleInput,
): Promise<LastfmScrobbleResult> {
  const { plays } = LastfmScrobbleInputSchema.parse(input)
  const config = await settings()
  const session = activeSession(config, await storedSession(userId))
  if (!config || !session)
    return LastfmScrobbleResultSchema.parse({
      connected: false,
      accepted: 0,
      scrobbled: 0,
      waiting: 0,
    })
  const accepted = await storePlays(userId, plays)
  const scrobbled = await sendWaitingPlays(userId, config, session, Date.now())
  return LastfmScrobbleResultSchema.parse({
    connected: true,
    accepted,
    scrobbled,
    waiting: await waitingCount(userId),
  })
}
