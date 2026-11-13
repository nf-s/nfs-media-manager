import { createHash, timingSafeEqual } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { ProviderRequestError } from '@repo/media-plugin-sdk'
import {
  YOUTUBE_SCOPE,
  YoutubeAccountStatusSchema,
  YoutubeCallbackSchema,
  YoutubeDisconnectResultSchema,
  type YoutubeAccountStatus,
} from '@repo/schemas/youtube'
import { db } from '@/lib/db'
import { env } from '@/env'
import { decryptSecretValue, encryptSecretValue } from '@/lib/crypto'
import { ServerError } from '@/lib/error'
import { resolveProviderSecrets } from '@/lib/provider-secrets'
import {
  youtubeAuthorization,
  youtubeRedirectUri,
  youtubeToken,
  type YoutubeRequest,
} from '@/lib/youtube-api'
import { youtubePlugin } from '@/plugins/builtin/youtube'
import { providerSecret } from '@/schemas/db'
import {
  clearProviderAccessHalt,
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
const NOT_CONNECTED = 'Connect a YouTube account in Subscriptions first.'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const namespace = (userId: string) => `youtube-account-${hash(userId)}`
type SecretDatabase = Pick<typeof db, 'insert' | 'select' | 'delete' | 'update'>

function unavailable(message: string) {
  return new ServerError({ statusCode: 422, message })
}

function hasScope(granted: string | undefined) {
  return (granted?.split(' ') ?? []).includes(YOUTUBE_SCOPE)
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
    .where(eq(providerSecret.provider, 'youtube'))
  const secrets = resolveProviderSecrets(
    'youtube',
    rows,
    youtubePlugin.manifest.secrets,
  )
  const clientId = secrets['clientId']
  const clientSecret = secrets['clientSecret']
  const redirect = secrets['redirectUri']
  if (!clientId || !clientSecret || !redirect) return null
  try {
    return { clientId, clientSecret, redirectUri: youtubeRedirectUri(redirect) }
  } catch {
    return null
  }
}

async function youtubeOperation<T>(
  execute: (request: YoutubeRequest) => Promise<T>,
): Promise<T> {
  try {
    const result = await execute(createProviderRequest(youtubePlugin))
    await recordProviderSuccess('youtube')
    return result
  } catch (error) {
    if (error instanceof ServerError) throw error
    await recordProviderFailure(youtubePlugin, error)
    throw unavailable(
      error instanceof ProviderRequestError
        ? error.message
        : 'Google sign-in failed or returned invalid data. No further requests were made; review provider status before retrying.',
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

export async function getYoutubeAccountStatus(
  userId: string,
): Promise<YoutubeAccountStatus> {
  const configured = await settings()
  const account = await storedAccount(userId)
  return YoutubeAccountStatusSchema.parse({
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

function youtubeCompletionUrl() {
  const destination = new URL(
    '/api/v1/youtube/complete',
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

export async function authorizeYoutube(
  userId: string,
  sessionId: string,
  browserOrigin = new URL(env.APP_URL).origin,
) {
  const config = await settings()
  if (!config)
    throw unavailable(
      'Configure the YouTube OAuth client ID, client secret and a valid redirect URI in Providers first',
    )
  const browser = new URL(browserOrigin)
  if (!env.TRUSTED_ORIGINS.includes(browser.origin))
    throw unavailable('Start YouTube authorization from a trusted app origin.')
  youtubeCompletionUrl()
  const authorization = youtubeAuthorization(
    config.clientId,
    config.redirectUri,
  )
  const expiresAt = Date.now() + 10 * 60 * 1000
  await writeSecret(db, userId, 'state', {
    stateHash: hash(authorization.state),
    sessionHash: hash(sessionId),
    verifier: authorization.verifier,
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

export function youtubeCallbackDestination(
  input: z.infer<typeof YoutubeCallbackSchema>,
) {
  const options = YoutubeCallbackSchema.parse(input)
  // The registered callback origin may carry no session cookie. Only relay to
  // our configured API; the authenticated completion endpoint validates and
  // consumes state.
  const destination = youtubeCompletionUrl()
  destination.searchParams.set('state', options.state)
  if (options.code) destination.searchParams.set('code', options.code)
  if (options.error) destination.searchParams.set('error', options.error)
  return destination.href
}

export async function finishYoutubeAuthorization(
  input: z.infer<typeof YoutubeCallbackSchema>,
  userId: string,
  sessionId: string,
) {
  const options = YoutubeCallbackSchema.parse(input)
  const config = await settings()
  const state = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(providerSecret)
      .where(accountSecret(userId, 'state'))
      .for('update')
    if (!row)
      throw unavailable(
        'YouTube authorization expired or unavailable. Connect again.',
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
        'YouTube authorization expired or does not match this session. Connect again.',
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
  await youtubeOperation(async (request) => {
    const token = await youtubeToken(
      request,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: state.redirectUri,
        client_id: state.clientId,
        client_secret: state.clientSecret,
        code_verifier: state.verifier,
      }),
    )
    if (!token.refresh_token || !hasScope(token.scope))
      throw new Error('Google did not grant YouTube subscription access')
    const refreshToken = token.refresh_token
    const scope = token.scope ?? ''
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
          'YouTube authorization was disconnected, replaced or expired. Connect again.',
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
  // A new sign-in is an explicit credential update; quota cooldowns remain.
  await clearProviderAccessHalt('youtube')
  return { connected: true, returnOrigin: state.returnOrigin }
}

/**
 * A current access token for the account, refreshed through the given request
 * gate when it is about to expire.
 */
export async function youtubeAccessToken(
  userId: string,
  request: YoutubeRequest,
) {
  const config = await settings()
  if (!config)
    throw unavailable(
      'YouTube is not configured. Add the OAuth client in Providers and connect the account.',
    )
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
      throw unavailable('YouTube account configuration changed. Connect again.')
    if (account.expiresAt > Date.now() + 60000) return account.accessToken
    let token: Awaited<ReturnType<typeof youtubeToken>>
    try {
      token = await youtubeToken(
        request,
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: account.refreshToken,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }),
      )
    } catch (error) {
      // Google answers an expired or revoked refresh token with HTTP 400.
      if (
        error instanceof ProviderRequestError &&
        error.code === 'request-failed' &&
        error.message.includes('HTTP 400')
      )
        throw unavailable(
          'Google rejected the saved YouTube sign-in. Connect the account again.',
        )
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

/** Deletes the account's tokens and pending authorization; stored videos are kept. */
export async function disconnectYoutube(userId: string) {
  await db
    .delete(providerSecret)
    .where(
      and(
        eq(providerSecret.provider, namespace(userId)),
        eq(providerSecret.lastUpdatedByUserId, userId),
      ),
    )
  return YoutubeDisconnectResultSchema.parse({ disconnected: true })
}
