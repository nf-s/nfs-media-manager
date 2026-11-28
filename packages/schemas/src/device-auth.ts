import { z } from 'zod'

/** A pairing code is valid for ten minutes, like an account connection. */
export const DEVICE_PAIRING_LIFETIME_SECONDS = 10 * 60

/** 32 random bytes in base64url, the local worker token format. */
export const DevicePairingCodeSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid pairing code')

export const CreatedDevicePairingSchema = z.object({
  code: DevicePairingCodeSchema,
  expiresAt: z.string().datetime(),
})
export type CreatedDevicePairing = z.infer<typeof CreatedDevicePairingSchema>

export const DevicePairingExchangeSchema = z.strictObject({
  code: DevicePairingCodeSchema,
  deviceName: z.string().trim().min(1).max(100),
})
export type DevicePairingExchange = z.infer<typeof DevicePairingExchangeSchema>
