import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  options: vi.fn(),
  connect: vi.fn(async () => {}),
  end: vi.fn(async () => {}),
  migrate: vi.fn(async () => {}),
}))

vi.mock('@/env', () => ({
  env: {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://fixture:password@database.invalid/library',
    DATABASE_HOST: 'wrong-host.invalid',
    DATABASE_PORT: 5431,
    DATABASE_USER: 'wrong-user',
    DATABASE_PASSWORD: 'wrong-password',
    DATABASE_NAME: 'wrong-database',
  },
}))
vi.mock('pg', () => ({
  default: {
    Client: class {
      constructor(options: unknown) {
        mocks.options(options)
      }
      connect = mocks.connect
      end = mocks.end
    },
    Pool: class {
      constructor(options: unknown) {
        mocks.options(options)
      }
    },
  },
}))
vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: () => ({
    query: { user: { findFirst: async () => ({ id: 'admin' }) } },
  }),
}))
vi.mock('drizzle-orm/node-postgres/migrator', () => ({
  migrate: mocks.migrate,
}))

describe('database administration connections', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubEnv('INITIAL_USER_EMAIL', 'administrator@example.com')
    vi.stubEnv('INITIAL_USER_NAME', 'Administrator')
    vi.stubEnv('INITIAL_USER_PASSWORD', 'offline-admin-password')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each([
    ['migration', () => import('../../scripts/migrate')],
    ['seed', () => import('../../scripts/seed')],
  ])('uses the configured URL and verified TLS for %s', async (_, load) => {
    await load()
    await vi.waitFor(() => expect(mocks.end).toHaveBeenCalledOnce())
    expect(mocks.options).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: expect.stringContaining('database.invalid/library'),
        ssl: { rejectUnauthorized: true },
      }),
    )
  })

  it('uses the same URL and TLS policy for the application pool', async () => {
    await import('./db')
    expect(mocks.options).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: expect.stringContaining('database.invalid/library'),
        ssl: { rejectUnauthorized: true },
      }),
    )
  })

  it('uses the same URL and TLS policy for Drizzle tooling', async () => {
    const { default: configuration } = await import('../../drizzle.config')
    expect(configuration.dbCredentials).toEqual({
      url: 'postgresql://fixture:password@database.invalid/library?sslmode=verify-full',
      ssl: { rejectUnauthorized: true },
    })
  })
})
