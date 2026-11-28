import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  NODE_ENV: 'production',
  RUNTIME_KIND: 'node',
}))
vi.mock('@/env', () => ({ env }))
vi.mock('@/lib/db', () => ({ db: {} }))

import { takeDevicePairingAttempt } from '../device-pairing'

const from = (headers: Record<string, string>) => new Headers(headers)

describe('device pairing attempts', () => {
  beforeEach(() => {
    env.NODE_ENV = 'production'
    env.RUNTIME_KIND = 'node'
  })

  it('allows three attempts per address in ten seconds', () => {
    const now = 1_000_000
    const headers = from({ 'x-forwarded-for': '192.0.2.1, 198.51.100.1' })
    for (let attempt = 0; attempt < 3; attempt += 1)
      expect(takeDevicePairingAttempt(headers, now + attempt)).toEqual({
        allowed: true,
      })
    expect(takeDevicePairingAttempt(headers, now + 3_000)).toEqual({
      allowed: false,
      retryAfter: 7,
    })
    expect(
      takeDevicePairingAttempt(from({ 'x-forwarded-for': '192.0.2.2' }), now),
    ).toEqual({ allowed: true })
    expect(takeDevicePairingAttempt(headers, now + 10_000)).toEqual({
      allowed: true,
    })
  })

  it('reads only the Worker header on Cloudflare', () => {
    env.RUNTIME_KIND = 'cloudflare'
    expect(() =>
      takeDevicePairingAttempt(from({ 'x-forwarded-for': '192.0.2.3' })),
    ).toThrow('Trusted client address required')
    expect(
      takeDevicePairingAttempt(from({ 'x-media-client-ip': '192.0.2.3' })),
    ).toEqual({ allowed: true })
  })

  it('shares one bucket without an address and does not limit development', () => {
    const now = 2_000_000
    for (let attempt = 0; attempt < 3; attempt += 1)
      expect(takeDevicePairingAttempt(from({}), now).allowed).toBe(true)
    expect(
      takeDevicePairingAttempt(from({ 'x-forwarded-for': 'not-an-ip' }), now)
        .allowed,
    ).toBe(false)
    env.NODE_ENV = 'development'
    expect(takeDevicePairingAttempt(from({}), now).allowed).toBe(true)
  })
})
