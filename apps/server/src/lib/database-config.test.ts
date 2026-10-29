import pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDatabaseConnectionOptions } from './database-config'

const configuration = {
  NODE_ENV: 'production',
  DATABASE_HOST: 'database.invalid',
  DATABASE_PORT: 5432,
  DATABASE_USER: 'fixture',
  DATABASE_PASSWORD: 'offline-password',
  DATABASE_NAME: 'library',
} satisfies Parameters<typeof getDatabaseConnectionOptions>[0]

afterEach(() => {
  vi.unstubAllEnvs()
  vi.doUnmock('@/lib/load-workspace-env')
  vi.resetModules()
})

describe('shared database connection policy', () => {
  it('uses component credentials and verified TLS in production', () => {
    expect(getDatabaseConnectionOptions(configuration)).toEqual({
      host: configuration.DATABASE_HOST,
      port: 5432,
      user: 'fixture',
      password: 'offline-password',
      database: 'library',
      ssl: { rejectUnauthorized: true },
    })
  })

  it('defaults local development to plaintext and allows an explicit production override', () => {
    expect(
      getDatabaseConnectionOptions({
        ...configuration,
        NODE_ENV: 'development',
      }).ssl,
    ).toBe(false)
    expect(
      getDatabaseConnectionOptions({
        ...configuration,
        DATABASE_SSL: 'disable',
      }).ssl,
    ).toBe(false)
    expect(
      getDatabaseConnectionOptions({
        ...configuration,
        NODE_ENV: 'development',
        DATABASE_SSL: 'verify',
      }).ssl,
    ).toEqual({ rejectUnauthorized: true })
  })

  it('gives URL credentials precedence and preserves the configured schema and other URL options', () => {
    const result = getDatabaseConnectionOptions({
      ...configuration,
      DATABASE_URL:
        'postgresql://url-user:url-password@url-host.invalid/url-library?application_name=fixture',
      DATABASE_SCHEMA: 'fixture_schema',
    })
    expect(result).not.toHaveProperty('host')
    expect(result).not.toHaveProperty('database')
    expect(result.options).toBe('-c search_path=fixture_schema,public')
    if (!('connectionString' in result))
      throw new Error('Expected URL connection')
    const url = new URL(result.connectionString)
    expect(url.hostname).toBe('url-host.invalid')
    expect(url.pathname).toBe('/url-library')
    expect(url.username).toBe('url-user')
    expect(url.searchParams.get('application_name')).toBe('fixture')
  })

  it.each([
    'sslmode=no-verify',
    'sslmode=disable',
    'ssl=false',
    'uselibpqcompat=true&sslmode=require',
  ])('prevents URL %s from weakening production TLS', (query) => {
    const options = getDatabaseConnectionOptions({
      ...configuration,
      DATABASE_URL: `postgresql://fixture:password@database.invalid/library?${query}`,
    })
    const client = new pg.Client(options)
    // pg replaces the explicit SSL object when parsing URL TLS parameters;
    // its empty TLS options retain Node's certificate and hostname checks.
    expect(client.ssl).toEqual({})
  })

  it('honors explicit plaintext mode even when the URL requests TLS', () => {
    const client = new pg.Client(
      getDatabaseConnectionOptions({
        ...configuration,
        DATABASE_SSL: 'disable',
        DATABASE_URL:
          'postgresql://fixture:password@database.invalid/library?sslmode=require',
      }),
    )
    expect(client.ssl).toBe(false)
  })

  it('rejects unknown TLS modes at the environment boundary', async () => {
    vi.doMock('@/lib/load-workspace-env', () => ({
      loadWorkspaceEnv: () => {},
    }))
    vi.stubEnv('DATABASE_SSL', 'no-verify')
    await expect(import('@/env')).rejects.toThrow(
      'Invalid environment variables',
    )
  })
})
