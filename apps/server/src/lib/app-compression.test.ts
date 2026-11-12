import { gunzipSync } from 'node:zlib'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  env: {
    NODE_ENV: 'test',
    RUNTIME_KIND: 'cloudflare',
    OWNER_EMAIL: 'owner@example.com',
    TRUSTED_ORIGINS: ['http://localhost:3000'],
  },
  getSession: vi.fn(),
  handler: vi.fn(),
}))

vi.mock('@/env', () => ({ env: mocks.env }))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: mocks.getSession }, handler: mocks.handler },
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.env.RUNTIME_KIND = 'cloudflare'
  mocks.getSession.mockResolvedValue({
    user: { id: 'owner', email: 'owner@example.com', role: 'admin' },
    session: { id: 'owner-session', userId: 'owner' },
  })
})

describe('application compression by runtime', () => {
  it('returns raw OpenAPI JSON without content encoding in Cloudflare despite gzip negotiation', async () => {
    const { default: app } = await import('@/app')
    const response = await app.request('/api/v1/doc', {
      headers: { 'accept-encoding': 'gzip, deflate, br' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('cache-control')).toContain('no-store')
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(bytes.byteLength).toBeGreaterThan(1024)
    expect(bytes[0]).toBe(0x7b)
    const document: unknown = JSON.parse(new TextDecoder().decode(bytes))
    expect(document).toMatchObject({
      openapi: '3.0.0',
      paths: expect.any(Object),
    })
  })

  it('leaves auth JSON uncompressed for the Cloudflare service-binding proxy', async () => {
    const payload = { user: { id: 'owner', name: 'Owner '.repeat(256) } }
    mocks.handler.mockResolvedValue(Response.json(payload))
    const { default: app } = await import('@/app')
    const response = await app.request('/api/auth/get-session', {
      headers: { 'accept-encoding': 'gzip' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(await response.json()).toEqual(payload)
  })

  it('retains single-pass gzip negotiation and raw identity responses in Node', async () => {
    mocks.env.RUNTIME_KIND = 'node'
    const { default: app } = await import('@/app')
    const identity = await app.request('/api/v1/doc', {
      headers: { 'accept-encoding': 'identity' },
    })
    expect(identity.status).toBe(200)
    expect(identity.headers.get('content-encoding')).toBeNull()
    const expectedDocument: unknown = await identity.json()

    const compressed = await app.request('/api/v1/doc', {
      headers: { 'accept-encoding': 'gzip' },
    })
    expect(compressed.status).toBe(200)
    expect(compressed.headers.get('content-encoding')).toBe('gzip')
    expect(compressed.headers.get('vary')).toContain('Accept-Encoding')
    expect(compressed.headers.get('cache-control')).toContain('no-store')
    const bytes = new Uint8Array(await compressed.arrayBuffer())
    expect(Array.from(bytes.subarray(0, 2))).toEqual([0x1f, 0x8b])
    const decoded = gunzipSync(bytes)
    expect(decoded[0]).toBe(0x7b)
    const actualDocument: unknown = JSON.parse(decoded.toString('utf8'))
    expect(actualDocument).toEqual(expectedDocument)
  })
})
