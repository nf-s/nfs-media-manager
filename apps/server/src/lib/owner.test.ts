import { describe, expect, it } from 'vitest'
import {
  assertOwnerConfiguration,
  isMutationOriginAllowed,
  isOwnerUser,
} from './owner'

const owner = { id: 'owner-1', email: 'owner@example.com', role: 'admin' }
const config = {
  NODE_ENV: 'production',
  OWNER_EMAIL: 'owner@example.com',
  TRUSTED_ORIGINS: ['https://media.example.com', 'http://localhost:3000'],
}

describe('owner policy', () => {
  it('requires a valid explicit owner in production', () => {
    for (const OWNER_EMAIL of [undefined, '', ' ', 'not-an-email']) {
      expect(() =>
        assertOwnerConfiguration({ NODE_ENV: 'production', OWNER_EMAIL }),
      ).toThrow('OWNER_EMAIL')
      expect(isOwnerUser(owner, { NODE_ENV: 'production', OWNER_EMAIL })).toBe(
        false,
      )
    }
    expect(() => assertOwnerConfiguration(config)).not.toThrow()
  })

  it('does not silently ignore a pinned ID without an owner email', () => {
    expect(() =>
      assertOwnerConfiguration({ OWNER_USER_ID: 'owner-1' }),
    ).toThrow('OWNER_EMAIL')
    expect(isOwnerUser(owner, { OWNER_USER_ID: 'owner-1' })).toBe(false)
  })

  it('retains authenticated local developer access without owner configuration', () => {
    expect(() =>
      assertOwnerConfiguration({ NODE_ENV: 'development' }),
    ).not.toThrow()
    expect(
      isOwnerUser({ ...owner, role: undefined }, { NODE_ENV: 'development' }),
    ).toBe(true)
    expect(isOwnerUser(null, { NODE_ENV: 'development' })).toBe(false)
  })

  it('requires normalized email, exact admin role and the optional ID in owner mode', () => {
    expect(
      isOwnerUser({ ...owner, email: ' OWNER@EXAMPLE.COM ' }, config),
    ).toBe(true)
    expect(isOwnerUser(owner, { ...config, OWNER_USER_ID: owner.id })).toBe(
      true,
    )
    expect(isOwnerUser(owner, { ...config, OWNER_USER_ID: 'different' })).toBe(
      false,
    )
    expect(isOwnerUser({ ...owner, role: 'Admin' }, config)).toBe(false)
    expect(isOwnerUser({ ...owner, role: 'admin,user' }, config)).toBe(false)
    expect(
      isOwnerUser({ ...owner, email: 'another@example.com' }, config),
    ).toBe(false)
  })

  it.each([
    null,
    undefined,
    [],
    {},
    { email: owner.email },
    { ...owner, role: true },
    { ...owner, id: 1 },
  ])('rejects invalid identity data %j', (user) => {
    expect(isOwnerUser(user, config)).toBe(false)
  })
})

describe('mutation origins', () => {
  it.each<HeadersInit>([
    { origin: 'https://media.example.com' },
    { origin: 'http://localhost:3000' },
    { referer: 'https://media.example.com/imports' },
    { origin: 'https://media.example.com', 'sec-fetch-site': 'cross-site' },
  ])(
    'accepts explicitly trusted browser/native client headers %j',
    (headers) => {
      expect(isMutationOriginAllowed(new Headers(headers), config)).toBe(true)
    },
  )

  it.each<HeadersInit>([
    {},
    { origin: 'null' },
    { origin: 'https://media.example.com.evil.invalid' },
    { origin: 'https://evil.invalid', referer: 'https://media.example.com/' },
    { referer: 'not-a-url' },
    { referer: 'https://evil.invalid/' },
    { 'sec-fetch-site': 'same-origin' },
    { 'sec-fetch-site': 'cross-site' },
  ])('rejects absent or hostile origins in owner mode %j', (headers) => {
    expect(isMutationOriginAllowed(new Headers(headers), config)).toBe(false)
    expect(
      isMutationOriginAllowed(new Headers(headers), {
        ...config,
        NODE_ENV: 'development',
      }),
    ).toBe(false)
  })

  it('preserves headerless localhost clients only when no owner is configured', () => {
    const local = {
      NODE_ENV: 'development',
      TRUSTED_ORIGINS: config.TRUSTED_ORIGINS,
    }
    expect(isMutationOriginAllowed(new Headers(), local)).toBe(true)
    expect(
      isMutationOriginAllowed(
        new Headers({ origin: 'https://evil.invalid' }),
        local,
      ),
    ).toBe(false)
    expect(
      isMutationOriginAllowed(
        new Headers({ 'sec-fetch-site': 'cross-site' }),
        local,
      ),
    ).toBe(false)
    expect(
      isMutationOriginAllowed(new Headers(), {
        ...local,
        NODE_ENV: 'production',
      }),
    ).toBe(false)
  })
})
