import { createHash, timingSafeEqual } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { ProviderRequestError } from '@repo/media-plugin-sdk'
import {
  SONOS_SCOPE,
  SonosAccountStatusSchema,
  SonosCallbackSchema,
  SonosDisconnectResultSchema,
  type SonosAccountStatus,
  type SonosCommand,
  type SonosContentInput,
  type SonosRooms,
} from '@repo/schemas/sonos'
import { db } from '@/lib/db'
import { env } from '@/env'
import { decryptSecretValue, encryptSecretValue } from '@/lib/crypto'
import { ServerError } from '@/lib/error'
import { resolveProviderSecrets } from '@/lib/provider-secrets'
import {
  sonosAuthorization,
  sonosCommand,
  sonosContent,
  sonosGroupState,
  sonosPlaying,
  sonosRedirectUri,
  sonosRooms,
  sonosToken,
  type SonosObservedAccount,
  type SonosRequest,
  type SonosSpotifyAccount,
} from '@/lib/sonos-api'
import { sonosPlugin } from '@/plugins/builtin/sonos'
import { providerSecret } from '@/schemas/db'
import {
  clearProviderAccessHalt,
  createDirectProviderRequest,
  createProviderRequest,
  recordProviderFailure,
  recordProviderSuccess,
} from './provider-requests'

const StateSchema = z.object({
  stateHash: z.string(),
  sessionHash: z.string(),
  clientId: z.string(),
  redirectUri: z.string(),
  returnOrigin: z.string().url(),
  expiresAt: z.number(),
  consumed: z.boolean().default(false),
})
const AccountSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number(),
  scope: z.string(),
  clientId: z.string(),
})
/** Each household's Spotify account, by household id. */
const SpotifyAccountsSchema = z.record(
  z.string(),
  z.object({ serviceId: z.string().min(1), accountId: z.string().min(1) }),
)
const NOT_CONNECTED = 'Connect Sonos in the player, under Play on, first.'
const REJECTED = 'Sonos rejected the saved sign-in. Connect the account again.'
const REFUSED =
  'Sonos did not accept that. The room may have changed; try again.'
const UNKNOWN_SPOTIFY =
  'Play Spotify on this room once from a Spotify app, so its Spotify account is known.'
const REFRESH_MARGIN_MS = 60000
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const namespace = (userId: string) => `sonos-account-${hash(userId)}`
type SecretDatabase = Pick<typeof db, 'insert' | 'select' | 'delete' | 'update'>

function unavailable(message: string) {
  return new ServerError({ statusCode: 422, message })
}

function hasScope(granted: string | undefined) {
  return (granted?.split(' ') ?? []).includes(SONOS_SCOPE)
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

async function settings() {
  const rows = await db
    .select()
    .from(providerSecret)
    .where(eq(providerSecret.provider, 'sonos'))
  const secrets = resolveProviderSecrets(
    'sonos',
    rows,
    sonosPlugin.manifest.secrets,
  )
  const clientId = secrets['clientId']
  const clientSecret = secrets['clientSecret']
  const redirect = secrets['redirectUri']
  if (!clientId || !clientSecret || !redirect) return null
  try {
    return { clientId, clientSecret, redirectUri: sonosRedirectUri(redirect) }
  } catch {
    return null
  }
}

/**
 * Runs Sonos requests and reports their failure as the provider's. `direct`
 * is for Control API calls: someone is waiting on each of them, and the
 * durable request gate takes as long as Sonos itself does to answer.
 */
async function sonosOperation<T>(
  execute: (request: SonosRequest) => Promise<T>,
  direct = false,
): Promise<T> {
  try {
    if (direct) return await execute(createDirectProviderRequest(sonosPlugin))
    const result = await execute(createProviderRequest(sonosPlugin))
    await recordProviderSuccess('sonos')
    return result
  } catch (error) {
    if (error instanceof ServerError) throw error
    await recordProviderFailure(sonosPlugin, error)
    throw unavailable(
      error instanceof ProviderRequestError
        ? error.message
        : 'Sonos request failed or returned invalid data. No further requests were made; review provider status before retrying.',
    )
  }
}

async function storedAccount(userId: string) {
  const [row] = await db
    .select()
    .from(providerSecret)
    .where(accountSecret(userId, 'tokens'))
  return row
    ? AccountSchema.parse(JSON.parse(decryptSecretValue(row.encryptedValue)))
    : null
}

/** The Spotify accounts seen for the user's households. */
async function storedSpotifyAccounts(
  userId: string,
): Promise<Map<string, SonosSpotifyAccount>> {
  const [row] = await db
    .select()
    .from(providerSecret)
    .where(accountSecret(userId, 'spotify'))
  if (!row) return new Map()
  return new Map(
    Object.entries(
      SpotifyAccountsSchema.parse(
        JSON.parse(decryptSecretValue(row.encryptedValue)),
      ),
    ),
  )
}

/**
 * Saves the Spotify accounts seen in a read when they are new or changed. A
 * household with several Spotify accounts keeps its saved one while any group
 * still reports it.
 */
async function rememberSpotifyAccounts(
  userId: string,
  stored: Map<string, SonosSpotifyAccount>,
  observed: SonosObservedAccount[],
) {
  const accounts = new Map(stored)
  let changed = false
  for (const { household, serviceId, accountId } of observed) {
    const saved = accounts.get(household)
    const reported = (account: SonosSpotifyAccount) =>
      observed.some(
        (seen) =>
          seen.household === household &&
          seen.serviceId === account.serviceId &&
          seen.accountId === account.accountId,
      )
    if (saved && reported(saved)) continue
    accounts.set(household, { serviceId, accountId })
    changed = true
  }
  if (changed)
    await writeSecret(db, userId, 'spotify', Object.fromEntries(accounts))
}

export async function getSonosAccountStatus(
  userId: string,
): Promise<SonosAccountStatus> {
  const configured = await settings()
  const account = await storedAccount(userId)
  return SonosAccountStatusSchema.parse({
    configured: configured !== null,
    connected: Boolean(
      account &&
      configured &&
      account.clientId === configured.clientId &&
      hasScope(account.scope),
    ),
    redirectUri: configured?.redirectUri ?? null,
  })
}

function sonosCompletionUrl() {
  const destination = new URL(
    '/api/v1/sonos/complete',
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

export async function authorizeSonos(
  userId: string,
  sessionId: string,
  browserOrigin = new URL(env.APP_URL).origin,
) {
  const config = await settings()
  if (!config)
    throw unavailable(
      'Configure the Sonos integration key, secret and a valid redirect URI in Providers first',
    )
  const browser = new URL(browserOrigin)
  if (!env.TRUSTED_ORIGINS.includes(browser.origin))
    throw unavailable('Start Sonos authorization from a trusted app origin.')
  sonosCompletionUrl()
  const authorization = sonosAuthorization(config.clientId, config.redirectUri)
  const expiresAt = Date.now() + 10 * 60 * 1000
  await writeSecret(db, userId, 'state', {
    stateHash: hash(authorization.state),
    sessionHash: hash(sessionId),
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    returnOrigin: browser.origin,
    expiresAt,
  })
  return {
    url: authorization.url,
    expiresAt: new Date(expiresAt).toISOString(),
  }
}

export function sonosCallbackDestination(
  input: z.infer<typeof SonosCallbackSchema>,
) {
  const options = SonosCallbackSchema.parse(input)
  // The registered callback origin may carry no session cookie. Only relay to
  // our configured API; the authenticated completion endpoint validates and
  // consumes state.
  const destination = sonosCompletionUrl()
  destination.searchParams.set('state', options.state)
  if (options.code) destination.searchParams.set('code', options.code)
  if (options.error) destination.searchParams.set('error', options.error)
  return destination.href
}

export async function finishSonosAuthorization(
  input: z.infer<typeof SonosCallbackSchema>,
  userId: string,
  sessionId: string,
) {
  const options = SonosCallbackSchema.parse(input)
  const config = await settings()
  const state = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(providerSecret)
      .where(accountSecret(userId, 'state'))
      .for('update')
    if (!row)
      throw unavailable(
        'Sonos authorization expired or unavailable. Connect again.',
      )
    const saved = StateSchema.parse(
      JSON.parse(decryptSecretValue(row.encryptedValue)),
    )
    const expected = Buffer.from(saved.stateHash)
    const actual = Buffer.from(hash(options.state))
    if (
      saved.consumed ||
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual) ||
      saved.sessionHash !== hash(sessionId) ||
      saved.expiresAt <= Date.now() ||
      saved.clientId !== config?.clientId ||
      saved.redirectUri !== config.redirectUri
    ) {
      throw unavailable(
        'Sonos authorization expired or does not match this session. Connect again.',
      )
    }
    const encryptedValue = encryptSecretValue(
      JSON.stringify({ ...saved, consumed: true }),
    )
    await tx
      .update(providerSecret)
      .set({ encryptedValue })
      .where(eq(providerSecret.id, row.id))
    return {
      ...saved,
      rowId: row.id,
      encryptedValue,
      clientSecret: config.clientSecret,
    }
  })
  if (options.error || !options.code) {
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
  const code = options.code
  await sonosOperation(async (request) => {
    const token = await sonosToken(
      request,
      { clientId: state.clientId, clientSecret: state.clientSecret },
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: state.redirectUri,
      }),
    )
    // Sonos grants its one scope without always repeating it in the response.
    const scope = token.scope ?? SONOS_SCOPE
    if (!token.refresh_token || !hasScope(scope))
      throw new Error('Sonos did not grant playback control')
    const refreshToken = token.refresh_token
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
          'Sonos authorization was disconnected, replaced or expired. Connect again.',
        )
      await writeSecret(tx, userId, 'tokens', {
        accessToken: token.access_token,
        refreshToken,
        expiresAt: Date.now() + token.expires_in * 1000,
        scope,
        clientId: state.clientId,
      })
      await tx.delete(providerSecret).where(eq(providerSecret.id, state.rowId))
    })
  })
  // A new sign-in is an explicit credential update.
  await clearProviderAccessHalt('sonos')
  return { connected: true, returnOrigin: state.returnOrigin }
}

/**
 * A current access token for the account, refreshed with the given request
 * when it is about to expire.
 */
async function sonosAccessToken(userId: string, request: SonosRequest) {
  const [config, saved] = await Promise.all([settings(), storedAccount(userId)])
  if (!config)
    throw unavailable(
      'Sonos is not configured. Add the integration in Providers and connect Sonos in the player.',
    )
  // A token that is not due for a refresh is used as read, without the lock.
  if (
    saved &&
    saved.clientId === config.clientId &&
    hasScope(saved.scope) &&
    saved.expiresAt > Date.now() + REFRESH_MARGIN_MS
  )
    return saved.accessToken
  return db.transaction(async (tx) => {
    // Serialize refresh/disconnect so a refreshed token cannot overwrite a newer account state.
    const [row] = await tx
      .select()
      .from(providerSecret)
      .where(accountSecret(userId, 'tokens'))
      .for('update')
    if (!row) throw unavailable(NOT_CONNECTED)
    const account = AccountSchema.parse(
      JSON.parse(decryptSecretValue(row.encryptedValue)),
    )
    if (account.clientId !== config.clientId || !hasScope(account.scope))
      throw unavailable('Sonos account configuration changed. Connect again.')
    if (account.expiresAt > Date.now() + REFRESH_MARGIN_MS)
      return account.accessToken
    let token: Awaited<ReturnType<typeof sonosToken>>
    try {
      token = await sonosToken(
        request,
        config,
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: account.refreshToken,
        }),
      )
    } catch (error) {
      // An expired or revoked refresh token is answered with HTTP 400 or 401.
      if (
        error instanceof ProviderRequestError &&
        (error.code === 'access-denied' ||
          (error.code === 'request-failed' &&
            error.message.includes('HTTP 400')))
      )
        throw unavailable(REJECTED)
      throw error
    }
    await writeSecret(tx, userId, 'tokens', {
      ...account,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? account.refreshToken,
      expiresAt: Date.now() + token.expires_in * 1000,
      scope: token.scope ?? account.scope,
    })
    return token.access_token
  })
}

/** Runs Control API calls with a current token; a rejected token asks for a new sign-in. */
function withSonos<T>(
  userId: string,
  execute: (request: SonosRequest, token: string) => Promise<T>,
  refused?: string,
) {
  return sonosOperation(async (request) => {
    const token = await sonosAccessToken(userId, request)
    try {
      return await execute(request, token)
    } catch (error) {
      if (error instanceof ProviderRequestError) {
        if (error.code === 'access-denied') throw unavailable(REJECTED)
        if (refused && error.code === 'request-failed')
          throw unavailable(refused)
      }
      throw error
    }
  }, true)
}

/** The account's rooms and what they play, read from the Sonos cloud. */
export async function getSonosRooms(userId: string): Promise<SonosRooms> {
  const stored = await storedSpotifyAccounts(userId)
  const { result, accounts } = await withSonos(userId, (request, token) =>
    sonosRooms(request, token, new Set(stored.keys())),
  )
  await rememberSpotifyAccounts(userId, stored, accounts)
  return result
}

/** The Sonos group playing the Spotify track the player shows, if any. */
export async function findSonosPlayback(
  userId: string,
  playing: { trackUri: string; device: string },
) {
  const stored = await storedSpotifyAccounts(userId)
  const { result, accounts } = await withSonos(userId, (request, token) =>
    sonosPlaying(request, token, playing, new Set(stored.keys())),
  )
  await rememberSpotifyAccounts(userId, stored, accounts)
  return result
}

/** What a group plays now; its volume is read only when asked for. */
export async function getSonosGroupState(
  userId: string,
  groupId: string,
  query: { volume?: 'true' | 'false' },
) {
  return withSonos(userId, (request, token) =>
    sonosGroupState(request, token, groupId, query.volume === 'true'),
  )
}

/** Loads Spotify content on a group with its household's Spotify account. */
export async function loadSonosContent(
  userId: string,
  groupId: string,
  input: SonosContentInput,
) {
  const account = (await storedSpotifyAccounts(userId)).get(input.household)
  if (!account)
    throw new ServerError({ statusCode: 409, message: UNKNOWN_SPOTIFY })
  await withSonos(
    userId,
    (request, token) => sonosContent(request, token, groupId, account, input),
    REFUSED,
  )
  return { done: true as const }
}

export async function sendSonosCommand(
  userId: string,
  groupId: string,
  command: SonosCommand,
) {
  await withSonos(
    userId,
    (request, token) => sonosCommand(request, token, groupId, command),
    REFUSED,
  )
  return { done: true as const }
}

/** Deletes the account's tokens, pending authorization and Spotify accounts. */
export async function disconnectSonos(userId: string) {
  await db
    .delete(providerSecret)
    .where(
      and(
        eq(providerSecret.provider, namespace(userId)),
        eq(providerSecret.lastUpdatedByUserId, userId),
      ),
    )
  return SonosDisconnectResultSchema.parse({ disconnected: true })
}
