import { createHash, timingSafeEqual } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { ProviderRequestError } from '@repo/media-plugin-sdk'
import {
  SpotifyCallbackSchema,
  SpotifyDisconnectResultSchema,
} from '@repo/schemas/spotify'
import { db } from '@/lib/db'
import { env } from '@/env'
import { decryptSecretValue, encryptSecretValue } from '@/lib/crypto'
import { ServerError } from '@/lib/error'
import { resolveProviderSecrets } from '@/lib/provider-secrets'
import {
  SPOTIFY_SCOPE,
  spotifyAuthorization,
  spotifyRedirectUri,
  spotifyToken,
  type SpotifyRequest,
} from '@/lib/spotify-api'
import { spotifyPlugin } from '@/plugins/builtin/spotify'
import { providerSecret } from '@/schemas/db'
import {
  createProviderRequest,
  recordProviderFailure,
  recordProviderSuccess,
} from './provider-requests'

const StateSchema = z.object({
  stateHash: z.string(),
  sessionHash: z.string(),
  verifier: z.string(),
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
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const namespace = (userId: string) => `spotify-account-${hash(userId)}`
type SecretDatabase = Pick<typeof db, 'insert' | 'select' | 'delete' | 'update'>

function unavailable(message: string) {
  return new ServerError({ statusCode: 422, message })
}

async function readSecret(
  database: SecretDatabase,
  userId: string,
  key: string,
) {
  const [row] = await database
    .select()
    .from(providerSecret)
    .where(
      and(
        eq(providerSecret.provider, namespace(userId)),
        eq(providerSecret.key, key),
        eq(providerSecret.lastUpdatedByUserId, userId),
      ),
    )
  return row
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

async function settings() {
  const rows = await db
    .select()
    .from(providerSecret)
    .where(eq(providerSecret.provider, 'spotify'))
  const secrets = resolveProviderSecrets(
    'spotify',
    rows,
    spotifyPlugin.manifest.secrets,
  )
  const clientId = secrets['clientId']
  const redirect = secrets['redirectUri']
  if (!clientId || !redirect) return null
  try {
    return { clientId, redirectUri: spotifyRedirectUri(redirect) }
  } catch {
    return null
  }
}

export async function spotifyOperation<T>(
  execute: (request: SpotifyRequest) => Promise<T>,
): Promise<T> {
  try {
    const result = await execute(createProviderRequest(spotifyPlugin))
    await recordProviderSuccess('spotify')
    return result
  } catch (error) {
    if (error instanceof ServerError) throw error
    await recordProviderFailure(spotifyPlugin, error)
    throw unavailable(
      error instanceof ProviderRequestError
        ? error.message
        : 'Spotify request failed or returned invalid data. No further requests were made; review provider status before retrying.',
    )
  }
}

export async function getSpotifyAccountStatus(userId: string) {
  const configured = await settings()
  const row = await readSecret(db, userId, 'tokens')
  const account = row
    ? AccountSchema.parse(JSON.parse(decryptSecretValue(row.encryptedValue)))
    : null
  const connected = Boolean(
    account &&
    configured &&
    account.clientId === configured.clientId &&
    account.scope.split(' ').includes(SPOTIFY_SCOPE),
  )
  return {
    configured: configured !== null,
    connected,
    expiresAt:
      connected && account ? new Date(account.expiresAt).toISOString() : null,
    scope: connected ? SPOTIFY_SCOPE : null,
    redirectUri: configured?.redirectUri ?? null,
  }
}

export async function authorizeSpotify(
  userId: string,
  sessionId: string,
  browserOrigin = new URL(env.APP_URL).origin,
) {
  const config = await settings()
  if (!config)
    throw unavailable(
      'Configure Spotify Client ID and a valid OAuth redirect URI in Providers first',
    )
  const browser = new URL(browserOrigin)
  if (!env.TRUSTED_ORIGINS.includes(browser.origin)) {
    throw unavailable('Start Spotify authorization from a trusted app origin.')
  }
  spotifyCompletionUrl()
  const authorization = spotifyAuthorization(
    config.clientId,
    config.redirectUri,
  )
  const expiresAt = Date.now() + 10 * 60 * 1000
  await writeSecret(db, userId, 'state', {
    stateHash: hash(authorization.state),
    sessionHash: hash(sessionId),
    verifier: authorization.verifier,
    ...config,
    returnOrigin: browser.origin,
    expiresAt,
  })
  return {
    url: authorization.url,
    expiresAt: new Date(expiresAt).toISOString(),
  }
}

function spotifyCompletionUrl() {
  const destination = new URL(
    '/api/v1/spotify/complete',
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

export function spotifyCallbackDestination(
  input: z.infer<typeof SpotifyCallbackSchema>,
) {
  const options = SpotifyCallbackSchema.parse(input)
  // The loopback callback has no localhost cookie. Only relay to our configured
  // API; the authenticated completion endpoint validates and consumes state.
  const destination = spotifyCompletionUrl()
  destination.searchParams.set('state', options.state)
  if (options.code) destination.searchParams.set('code', options.code)
  if (options.error) destination.searchParams.set('error', options.error)
  return destination.href
}

export async function finishSpotifyAuthorization(
  input: z.infer<typeof SpotifyCallbackSchema>,
  userId: string,
  sessionId: string,
) {
  const options = SpotifyCallbackSchema.parse(input)
  const config = await settings()
  const state = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(providerSecret)
      .where(
        and(
          eq(providerSecret.provider, namespace(userId)),
          eq(providerSecret.key, 'state'),
          eq(providerSecret.lastUpdatedByUserId, userId),
        ),
      )
      .for('update')
    if (!row)
      throw unavailable(
        'Spotify authorization expired or unavailable. Connect again.',
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
        'Spotify authorization expired or does not match this session. Connect again.',
      )
    }
    const encryptedValue = encryptSecretValue(
      JSON.stringify({ ...saved, consumed: true }),
    )
    await tx
      .update(providerSecret)
      .set({ encryptedValue })
      .where(eq(providerSecret.id, row.id))
    return { ...saved, rowId: row.id, encryptedValue }
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
  await spotifyOperation(async (request) => {
    const token = await spotifyToken(
      request,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: state.redirectUri,
        client_id: state.clientId,
        code_verifier: state.verifier,
      }),
    )
    if (
      !token.refresh_token ||
      !token.scope?.split(' ').includes(SPOTIFY_SCOPE)
    )
      throw new Error('Spotify did not grant saved album access')
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
          'Spotify authorization was disconnected, replaced or expired. Connect again.',
        )
      await writeSecret(tx, userId, 'tokens', {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + token.expires_in * 1000,
        scope: token.scope,
        clientId: state.clientId,
      })
      await tx.delete(providerSecret).where(eq(providerSecret.id, state.rowId))
    })
  })
  return { connected: true, returnOrigin: state.returnOrigin }
}

export async function spotifyAccountToken(
  userId: string,
  request: SpotifyRequest,
) {
  const config = await settings()
  if (!config)
    throw unavailable(
      'Spotify is not configured. Configure and connect the account first.',
    )
  return db.transaction(async (tx) => {
    // Serialize refresh/disconnect so a rotated token cannot overwrite a newer account state.
    const [row] = await tx
      .select()
      .from(providerSecret)
      .where(
        and(
          eq(providerSecret.provider, namespace(userId)),
          eq(providerSecret.key, 'tokens'),
          eq(providerSecret.lastUpdatedByUserId, userId),
        ),
      )
      .for('update')
    if (!row)
      throw unavailable(
        'Connect a Spotify account before discovering saved albums',
      )
    const account = AccountSchema.parse(
      JSON.parse(decryptSecretValue(row.encryptedValue)),
    )
    if (
      account.clientId !== config.clientId ||
      !account.scope.split(' ').includes(SPOTIFY_SCOPE)
    )
      throw unavailable('Spotify account configuration changed. Connect again.')
    if (account.expiresAt > Date.now() + 60000) return account.accessToken
    const token = await spotifyToken(
      request,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: account.refreshToken,
        client_id: config.clientId,
      }),
    )
    const scope = token.scope ?? account.scope
    if (!scope.split(' ').includes(SPOTIFY_SCOPE))
      throw new Error('Spotify saved album permission is missing')
    await writeSecret(tx, userId, 'tokens', {
      ...account,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? account.refreshToken,
      expiresAt: Date.now() + token.expires_in * 1000,
      scope,
    })
    return token.access_token
  })
}

export async function disconnectSpotify(userId: string) {
  await db
    .delete(providerSecret)
    .where(
      and(
        eq(providerSecret.provider, namespace(userId)),
        eq(providerSecret.lastUpdatedByUserId, userId),
      ),
    )
  return SpotifyDisconnectResultSchema.parse({ disconnected: true })
}
