import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import {
  ApiKeySchema,
  ApiKeysSchema,
  CreatedApiKeySchema,
  CreateApiKeySchema,
  DEFAULT_API_KEY_RATE_LIMIT,
  type ApiKeyRateLimit,
  type CreateApiKey,
  type UpdateApiKeyRateLimit,
} from '@repo/schemas/api-key'
import { env } from '@/env'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { isOwnerUser } from '@/lib/owner'
import { apikey, user } from '@/schemas/db'

const configId = 'media-manager'
const rateLimitColumns = {
  rateLimitEnabled: apikey.rateLimitEnabled,
  rateLimitMax: apikey.rateLimitMax,
  rateLimitTimeWindow: apikey.rateLimitTimeWindow,
  requestCount: apikey.requestCount,
  lastRefillAt: apikey.lastRefillAt,
}
const metadataColumns = {
  id: apikey.id,
  name: apikey.name,
  start: apikey.start,
  createdAt: apikey.createdAt,
  expiresAt: apikey.expiresAt,
  lastRequest: apikey.lastRequest,
  enabled: apikey.enabled,
  ...rateLimitColumns,
}

type KeyRateLimitState = Pick<
  typeof apikey.$inferSelect,
  keyof typeof rateLimitColumns
>
type KeyMetadata = Pick<
  typeof apikey.$inferSelect,
  keyof typeof metadataColumns
>
type ApiKeyAuthentication =
  | {
      status: 'authenticated'
      id: string
      user: Pick<typeof user.$inferSelect, 'id' | 'name' | 'email' | 'role'>
    }
  | { status: 'limited'; retryAfter: number }

function windowMilliseconds(row: KeyRateLimitState) {
  return row.rateLimitTimeWindow !== null && row.rateLimitTimeWindow > 0
    ? row.rateLimitTimeWindow
    : DEFAULT_API_KEY_RATE_LIMIT.windowSeconds * 1000
}

function rateLimit(row: KeyRateLimitState): ApiKeyRateLimit {
  if (row.rateLimitEnabled === false) return { enabled: false }
  return {
    enabled: true,
    maxRequests:
      row.rateLimitMax !== null && row.rateLimitMax > 0
        ? row.rateLimitMax
        : DEFAULT_API_KEY_RATE_LIMIT.maxRequests,
    windowSeconds: windowMilliseconds(row) / 1000,
  }
}

function currentWindow(row: KeyRateLimitState, now: Date) {
  const resetAt = (row.lastRefillAt?.getTime() ?? 0) + windowMilliseconds(row)
  const elapsed = row.lastRefillAt === null || now.getTime() >= resetAt
  return {
    resetAt,
    elapsed,
    requestsUsed: elapsed ? 0 : Math.max(0, row.requestCount ?? 0),
  }
}

function rateLimitValues(limit: ApiKeyRateLimit) {
  return limit.enabled
    ? {
        rateLimitEnabled: true,
        rateLimitMax: limit.maxRequests,
        rateLimitTimeWindow: limit.windowSeconds * 1000,
      }
    : { rateLimitEnabled: false }
}

function metadata(row: KeyMetadata, now: Date) {
  const limit = rateLimit(row)
  return ApiKeySchema.parse({
    id: row.id,
    name: row.name ?? '',
    start: row.start ?? '',
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastRequest: row.lastRequest?.toISOString() ?? null,
    enabled: row.enabled === true,
    rateLimit: limit,
    requestsUsed: limit.enabled ? currentWindow(row, now).requestsUsed : null,
  })
}

export async function listApiKeys(userId: string) {
  const rows = await db
    .select(metadataColumns)
    .from(apikey)
    .where(and(eq(apikey.configId, configId), eq(apikey.referenceId, userId)))
    .orderBy(desc(apikey.createdAt), desc(apikey.id))
  const now = new Date()
  return ApiKeysSchema.parse(rows.map((row) => metadata(row, now)))
}

export async function createApiKey(userId: string, input: CreateApiKey) {
  const options = CreateApiKeySchema.parse(input)
  const now = new Date()
  const key = `mm_${randomBytes(32).toString('base64url')}`
  const [row] = await db
    .insert(apikey)
    .values({
      id: nanoid(),
      configId,
      referenceId: userId,
      name: options.name,
      start: key.slice(0, 11),
      prefix: 'mm_',
      key: createHash('sha256').update(key).digest('hex'),
      enabled: true,
      ...rateLimitValues(options.rateLimit ?? DEFAULT_API_KEY_RATE_LIMIT),
      requestCount: 0,
      expiresAt:
        options.expiresIn === null
          ? null
          : new Date(now.getTime() + options.expiresIn * 1000),
      createdAt: now,
      updatedAt: now,
    })
    .returning(metadataColumns)
  if (!row) throw new ServerError({ message: 'API key creation failed' })
  return CreatedApiKeySchema.parse({ apiKey: metadata(row, now), key })
}

export function createAgentAccess(userId: string) {
  return createApiKey(userId, { name: 'Agent access', expiresIn: 60 * 60 })
}

export async function updateApiKeyRateLimit(
  userId: string,
  id: string,
  input: UpdateApiKeyRateLimit,
) {
  const condition = and(
    eq(apikey.id, id),
    eq(apikey.configId, configId),
    eq(apikey.referenceId, userId),
  )
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select(rateLimitColumns)
      .from(apikey)
      .where(condition)
      .for('update')
    if (!row)
      throw new ServerError({ statusCode: 404, message: 'API key not found' })
    const now = new Date()
    // Lengthening a window must not bring back requests from an elapsed window.
    const clearElapsed =
      row.lastRefillAt !== null && currentWindow(row, now).elapsed
    const [updated] = await tx
      .update(apikey)
      .set({
        ...rateLimitValues(input.rateLimit),
        ...(clearElapsed ? { requestCount: 0, lastRefillAt: null } : {}),
        updatedAt: now,
      })
      .where(condition)
      .returning(metadataColumns)
    if (!updated)
      throw new ServerError({ statusCode: 404, message: 'API key not found' })
    return metadata(updated, now)
  })
}

export async function revokeApiKey(userId: string, id: string) {
  const [row] = await db
    .update(apikey)
    .set({ enabled: false, updatedAt: new Date() })
    .where(
      and(
        eq(apikey.id, id),
        eq(apikey.configId, configId),
        eq(apikey.referenceId, userId),
      ),
    )
    .returning({ id: apikey.id })
  if (!row)
    throw new ServerError({ statusCode: 404, message: 'API key not found' })
  return row
}

export async function authenticateApiKey(
  key: string,
): Promise<ApiKeyAuthentication | null> {
  if (!/^mm_[A-Za-z0-9_-]{43}$/.test(key)) return null
  const hash = createHash('sha256').update(key).digest('hex')
  return db.transaction(async (tx): Promise<ApiKeyAuthentication | null> => {
    // Serialize verification with revocation and rate accounting for this key.
    // Check the current account identity on every request.
    const [row] = await tx
      .select({
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          banned: user.banned,
        },
        id: apikey.id,
        ...rateLimitColumns,
        expiresAt: apikey.expiresAt,
      })
      .from(apikey)
      .innerJoin(user, eq(user.id, apikey.referenceId))
      .where(
        and(
          eq(apikey.key, hash),
          eq(apikey.configId, configId),
          eq(apikey.enabled, true),
          or(isNull(apikey.expiresAt), gt(apikey.expiresAt, new Date())),
        ),
      )
      .for('update', { of: apikey })
    const now = new Date()
    if (
      !row ||
      row.user.banned === true ||
      !isOwnerUser(row.user, env) ||
      (row.expiresAt !== null && row.expiresAt <= now)
    )
      return null

    const limit = rateLimit(row)
    const { resetAt, elapsed, requestsUsed } = currentWindow(row, now)
    if (limit.enabled && requestsUsed >= limit.maxRequests)
      return {
        status: 'limited',
        retryAfter: Math.ceil((resetAt - now.getTime()) / 1000),
      }
    await tx
      .update(apikey)
      .set({
        ...(limit.enabled
          ? {
              requestCount: requestsUsed + 1,
              lastRefillAt: elapsed ? now : row.lastRefillAt,
            }
          : {}),
        lastRequest: now,
        updatedAt: now,
      })
      .where(eq(apikey.id, row.id))
    return { status: 'authenticated', id: row.id, user: row.user }
  })
}
