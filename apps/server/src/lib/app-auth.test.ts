import { beforeEach, describe, expect, it, vi } from 'vitest'
import { APIError } from 'better-auth/api'

const mocks = vi.hoisted(() => ({
  env: {
    NODE_ENV: 'test',
    OWNER_EMAIL: 'owner@example.com',
    OWNER_USER_ID: '',
    TRUSTED_ORIGINS: ['http://localhost:3000'],
  },
  getSession: vi.fn(),
  handler: vi.fn(),
  listProviders: vi.fn(),
}))

vi.mock('@/env', () => ({ env: mocks.env }))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: mocks.getSession }, handler: mocks.handler },
}))
vi.mock('@/services/providers', () => ({
  listProviders: mocks.listProviders,
}))

import app from '@/app'
import albums from '@/routes/albums'
import films from '@/routes/films'
import jobs from '@/routes/jobs'
import imports from '@/routes/imports'
import albumImports from '@/routes/album-imports'
import spotify from '@/routes/spotify'
import media from '@/routes/media'
import providers from '@/routes/providers'
import tags from '@/routes/tags'

function session(email = 'owner@example.com', role = 'admin', id = 'owner') {
  return {
    user: { id, email, role, name: 'Owner' },
    session: { id: 'session-1', userId: id },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.env.NODE_ENV = 'test'
  mocks.env.OWNER_EMAIL = 'owner@example.com'
  mocks.env.OWNER_USER_ID = ''
  mocks.getSession.mockResolvedValue(session())
  mocks.listProviders.mockResolvedValue([])
  mocks.handler.mockResolvedValue(new Response('{}'))
})

describe('application privacy boundary', () => {
  it.each([
    { name: 'albums', routes: albums },
    { name: 'films', routes: films },
    { name: 'jobs', routes: jobs },
    { name: 'imports', routes: imports },
    { name: 'album imports', routes: albumImports },
    { name: 'Spotify', routes: spotify },
    { name: 'media', routes: media },
    { name: 'providers', routes: providers },
    { name: 'tags', routes: tags },
  ])('generates the $name OpenAPI contract', ({ routes }) => {
    routes.getOpenAPIDocument({
      openapi: '3.0.0',
      info: { title: 'Contract test', version: '1' },
    })
  })

  it('serves the complete OpenAPI contract to the owner without caching it', async () => {
    const response = await app.request('/api/v1/doc')
    expect(response.status, await response.clone().text()).toBe(200)
    const document: unknown = await response.json()
    expect(document).toMatchObject({
      openapi: '3.0.0',
      paths: {
        '/api/v1/albums': expect.any(Object),
        '/api/v1/films': expect.any(Object),
        '/api/v1/providers': expect.any(Object),
      },
      components: { schemas: { JsonValue: expect.any(Object) } },
    })
    expect(JSON.stringify(document)).toContain(
      '"$ref":"#/components/schemas/JsonValue"',
    )
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('cdn-cache-control')).toBe('no-store')
  })

  it.each([
    '/api/v1/doc',
    '/api/v1/scalar',
    '/api/v1/providers',
    '/api/v1/films',
    '/api/v1/albums',
    '/api/v1/media',
    '/api/v1/imports',
    '/api/v1/album-imports',
    '/api/v1/scrape/jobs',
    '/api/v1/tags',
    '/api/v1/spotify/status',
    '/api/v1/spotify/complete',
  ])('protects %s from anonymous access', async (path) => {
    mocks.getSession.mockResolvedValue(null)
    const response = await app.request(path)
    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it.each([
    session('other@example.com'),
    session('owner@example.com', 'user'),
    session('owner@example.com', ''),
  ])('denies non-owner identity %j', async (value) => {
    mocks.getSession.mockResolvedValue(value)
    for (const path of ['/api/v1/providers', '/api/v1/doc', '/api/v1/scalar']) {
      expect((await app.request(path)).status).toBe(403)
    }
    expect(mocks.listProviders).not.toHaveBeenCalled()
  })

  it('normalizes owner email and resolves a session only once', async () => {
    mocks.env.OWNER_EMAIL = ' OWNER@example.com '
    mocks.getSession.mockResolvedValue(session('Owner@Example.Com'))
    const response = await app.request('/api/v1/providers')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(mocks.getSession).toHaveBeenCalledTimes(1)
  })

  it('enforces an optional pinned owner ID', async () => {
    mocks.env.OWNER_USER_ID = 'another-owner'
    expect((await app.request('/api/v1/providers')).status).toBe(403)
  })

  it('preserves a forbidden Better Auth response rather than converting it to a server error', async () => {
    mocks.getSession.mockRejectedValue(
      new APIError('FORBIDDEN', { message: 'Forbidden' }),
    )
    expect((await app.request('/api/v1/providers')).status).toBe(403)
  })

  it('rejects mismatched session and user identities', async () => {
    mocks.getSession.mockResolvedValue({
      ...session(),
      session: { id: 'session-1', userId: 'another-user' },
    })
    expect((await app.request('/api/v1/providers')).status).toBe(403)
  })

  it.each<HeadersInit>([
    {},
    { origin: 'https://evil.example' },
    { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' },
    { referer: 'https://evil.example/form' },
  ])('rejects unsafe mutation headers %j', async (headers) => {
    const response = await app.request('/api/v1/not-a-route', {
      method: 'POST',
      headers,
    })
    expect(response.status).toBe(403)
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('allows an explicit trusted origin for native clients and browsers', async () => {
    expect(
      (
        await app.request('/api/v1/not-a-route', {
          method: 'POST',
          headers: { origin: 'http://localhost:3000' },
        })
      ).status,
    ).toBe(404)
  })

  it('checks login origins before invoking Better Auth', async () => {
    expect(
      (
        await app.request('/api/auth/sign-in/email', {
          method: 'POST',
          headers: { origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403)
    expect(mocks.handler).not.toHaveBeenCalled()
  })

  it('serves the API reference only to the owner without caching it', async () => {
    const response = await app.request('/api/v1/scalar')
    expect(response.status, await response.text()).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('cdn-cache-control')).toBe('no-store')
    expect(response.headers.get('cloudflare-cdn-cache-control')).toBe(
      'no-store',
    )
  })

  it('does not resolve sessions before dispatching authentication', async () => {
    const response = await app.request('/api/auth/get-session')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(mocks.getSession).not.toHaveBeenCalled()
  })

  it('keeps a minimal healthcheck public without querying sessions', async () => {
    expect((await app.request('/api/v1/healthcheck')).status).toBe(200)
    expect(mocks.getSession).not.toHaveBeenCalled()
  })
})
