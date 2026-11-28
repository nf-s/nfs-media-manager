import { describe, expect, it } from 'vitest'
import { ApiKeySchema } from '../src/api-key'
import {
  DevicePairingCodeSchema,
  DevicePairingExchangeSchema,
} from '../src/device-auth'

describe('device pairing', () => {
  const code = 'a'.repeat(43)

  it('accepts only a 43-character base64url code', () => {
    expect(DevicePairingCodeSchema.safeParse(code).success).toBe(true)
    expect(
      DevicePairingCodeSchema.safeParse('A-_9'.repeat(10) + 'abc').success,
    ).toBe(true)
    for (const invalid of [
      'a'.repeat(42),
      'a'.repeat(44),
      `${'a'.repeat(42)}=`,
    ])
      expect(DevicePairingCodeSchema.safeParse(invalid).success).toBe(false)
  })

  it('trims the device name and rejects other fields', () => {
    expect(
      DevicePairingExchangeSchema.parse({ code, deviceName: ' Phone ' }),
    ).toEqual({ code, deviceName: 'Phone' })
    for (const body of [
      { code, deviceName: ' ' },
      { code, deviceName: 'x'.repeat(101) },
      { code },
      { code, deviceName: 'Phone', expiresIn: null },
    ])
      expect(DevicePairingExchangeSchema.safeParse(body).success).toBe(false)
  })

  it('reads keys without a kind as API keys', () => {
    const key = {
      id: 'key-1',
      name: 'Script',
      start: 'mm_abcdefgh',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
      lastRequest: null,
      enabled: true,
      rateLimit: { enabled: false },
      requestsUsed: null,
    }
    expect(ApiKeySchema.parse(key).kind).toBe('api')
    expect(ApiKeySchema.parse({ ...key, kind: 'device' }).kind).toBe('device')
    expect(ApiKeySchema.safeParse({ ...key, kind: 'other' }).success).toBe(
      false,
    )
  })
})
