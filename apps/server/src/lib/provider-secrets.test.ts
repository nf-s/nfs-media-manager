import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encryptSecretValue } from '@/lib/crypto'
import {
  isProviderSecretConfigured,
  resolveProviderSecrets,
} from '@/lib/provider-secrets'

const originalTmdbApiKey = process.env.TMDB_API_KEY

describe('provider secret resolution', () => {
  beforeEach(() => {
    delete process.env.TMDB_API_KEY
  })

  afterEach(() => {
    if (typeof originalTmdbApiKey === 'string') {
      process.env.TMDB_API_KEY = originalTmdbApiKey
      return
    }

    delete process.env.TMDB_API_KEY
  })

  it('marks env-backed secrets as configured', () => {
    process.env.TMDB_API_KEY = 'env-value'

    expect(isProviderSecretConfigured('tmdb', 'apiKey', [])).toBe(true)
  })

  it('merges env fallbacks and lets stored secrets override them', () => {
    process.env.TMDB_API_KEY = 'env-value'

    const rows = [
      {
        id: 'secret-1',
        provider: 'tmdb',
        key: 'apiKey',
        encryptedValue: encryptSecretValue('stored-value'),
        lastVerifiedAt: null,
        lastVerifiedStatus: null,
        lastUpdatedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]

    expect(resolveProviderSecrets('tmdb', [])).toEqual({
      apiKey: 'env-value',
    })
    expect(resolveProviderSecrets('tmdb', rows)).toEqual({
      apiKey: 'stored-value',
    })
  })
})
