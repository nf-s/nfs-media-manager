import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, isNotNull, isNull, lte, or } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import {
  CreatedDevicePairingSchema,
  DEVICE_PAIRING_LIFETIME_SECONDS,
  DevicePairingExchangeSchema,
  type DevicePairingExchange,
} from '@repo/schemas/device-auth'
import { env } from '@/env'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { devicePairing } from '@/schemas/db'
import { createDeviceApiKey } from '@/services/api-keys'

const hash = (code: string) => createHash('sha256').update(code).digest('hex')

export async function createDevicePairing(userId: string) {
  const now = new Date()
  const code = randomBytes(32).toString('base64url')
  const expiresAt = new Date(
    now.getTime() + DEVICE_PAIRING_LIFETIME_SECONDS * 1000,
  )
  await db.transaction(async (tx) => {
    await tx
      .delete(devicePairing)
      .where(
        and(
          eq(devicePairing.userId, userId),
          or(
            lte(devicePairing.expiresAt, now),
            isNotNull(devicePairing.consumedAt),
          ),
        ),
      )
    await tx.insert(devicePairing).values({
      id: nanoid(),
      userId,
      codeHash: hash(code),
      expiresAt,
      createdAt: now,
    })
  })
  return CreatedDevicePairingSchema.parse({
    code,
    expiresAt: expiresAt.toISOString(),
  })
}

/** Exchanges a pairing code once for a device API key. */
export async function exchangeDevicePairing(input: DevicePairingExchange) {
  const { code, deviceName } = DevicePairingExchangeSchema.parse(input)
  return db.transaction(async (tx) => {
    const now = new Date()
    // Only the digest is stored, so the lookup compares digests, as API key
    // authentication does. Claiming the row in one update makes it single-use.
    const [pairing] = await tx
      .update(devicePairing)
      .set({ consumedAt: now })
      .where(
        and(
          eq(devicePairing.codeHash, hash(code)),
          isNull(devicePairing.consumedAt),
          gt(devicePairing.expiresAt, now),
        ),
      )
      .returning({ userId: devicePairing.userId })
    if (!pairing)
      throw new ServerError({
        statusCode: 401,
        message: 'Pairing code is invalid, used or expired',
      })
    return createDeviceApiKey(tx, pairing.userId, deviceName)
  })
}

// The exchange is limited like email sign-in: Better Auth allows three
// attempts per ten seconds for each client address, in memory, in production.
const exchangeWindowMs = 10_000
const exchangeMaxAttempts = 3
const exchangeAttempts = new Map<string, { count: number; resetAt: number }>()
const clientIpSchema = z.union([z.ipv4(), z.ipv6()])

function clientAddress(headers: Headers): string | null {
  // The same headers Better Auth trusts for sign-in (`lib/auth.ts`).
  const value =
    env.RUNTIME_KIND === 'cloudflare'
      ? headers.get('x-media-client-ip')
      : headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const parsed = clientIpSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export type DevicePairingAttempt =
  | { allowed: true }
  | { allowed: false; retryAfter: number }

export function takeDevicePairingAttempt(
  headers: Headers,
  now = Date.now(),
): DevicePairingAttempt {
  if (env.NODE_ENV !== 'production') return { allowed: true }
  const address = clientAddress(headers)
  if (address === null && env.RUNTIME_KIND === 'cloudflare')
    throw new ServerError({
      statusCode: 403,
      message: 'Trusted client address required',
    })
  // Requests without a readable address share one bucket.
  const key = address ?? 'unknown'
  for (const [entry, { resetAt }] of exchangeAttempts)
    if (resetAt <= now) exchangeAttempts.delete(entry)
  const current = exchangeAttempts.get(key) ?? {
    count: 0,
    resetAt: now + exchangeWindowMs,
  }
  if (current.count >= exchangeMaxAttempts)
    return {
      allowed: false,
      retryAfter: Math.ceil((current.resetAt - now) / 1000),
    }
  exchangeAttempts.set(key, { ...current, count: current.count + 1 })
  return { allowed: true }
}
