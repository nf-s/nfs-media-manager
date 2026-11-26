import { describe, expect, it, vi } from 'vitest'
import '@hono/zod-openapi'
import {
  defaultRatingsRankingRequest,
  RatingsSourcesRequestSchema,
} from '@repo/schemas/ratings-explorer'

const { getSession, rankRatings, summarizeRatingsSources } = vi.hoisted(() => ({
  getSession: vi.fn(),
  rankRatings: vi.fn(),
  summarizeRatingsSources: vi.fn(),
}))
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession } } }))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/env', () => ({
  env: { NODE_ENV: 'test', TRUSTED_ORIGINS: ['https://example.test'] },
}))
vi.mock('@/services/ratings-explorer', () => ({
  rankRatings,
  summarizeRatingsSources,
}))

async function submit(
  body: unknown,
  origin = 'https://example.test',
  view = 'ranking',
) {
  const { default: app } = await import('@/app')
  return app.request('/api/v1/ratings/' + view, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body),
  })
}

describe('ratings ranking API', () => {
  it('checks access, origin and bounded inputs before running a ranking query', async () => {
    const film = { library: 'film' }
    getSession.mockResolvedValue(null)
    expect((await submit(film)).status).toBe(401)
    getSession.mockResolvedValue({
      user: { id: 'fixture-owner', email: 'owner@example.test' },
      session: { userId: 'fixture-owner', id: 'fixture-session' },
    })
    expect((await submit(film, 'https://other.example')).status).toBe(403)
    const entry = { key: 'plugin.fixture.value', weight: 0.5, minVotes: 10 }
    for (const invalid of [
      { library: 'track' },
      { ...film, limit: 101 },
      { ...film, offset: -1 },
      { ...film, minPlays: 3 },
      { ...film, search: 's'.repeat(201) },
      { ...film, yearFrom: 2021, yearTo: 2020 },
      { ...film, settings: { sources: [entry, entry] } },
      { ...film, settings: { sources: [{ ...entry, weight: 1.1 }] } },
      { ...film, settings: { sources: Array(65).fill(entry) } },
      { ...film, metadata: {} },
    ])
      expect((await submit(invalid)).status).toBe(422)
    expect(
      (await submit({ ...film, search: 'x'.repeat(32 * 1024) })).status,
    ).toBe(413)
    expect(rankRatings).not.toHaveBeenCalled()
    const page = { sources: [], rows: [], total: 0 }
    rankRatings.mockResolvedValue(page)
    const request = {
      ...defaultRatingsRankingRequest('album'),
      sort: entry.key,
    }
    request.settings.sources.push(entry)
    const response = await submit(request)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(await response.json()).toMatchObject({ data: page })
    expect(rankRatings).toHaveBeenCalledExactlyOnceWith(request)
    const { default: app } = await import('@/app')
    const docs = await app.request('/api/v1/doc')
    expect(docs.status).toBe(200)
    expect(await docs.json()).toMatchObject({
      paths: {
        '/api/v1/ratings/ranking': {
          post: { requestBody: { required: true } },
        },
      },
    })
  })
})

describe('ratings sources API', () => {
  it('authorizes and validates the aggregate before reading stored ratings', async () => {
    const film = { library: 'film' }
    const range = {
      dimension: 'native.plugin.fixture.value',
      first: 0,
      last: 3,
    }
    const request = RatingsSourcesRequestSchema.parse({
      ...film,
      ranges: [range],
    })
    const sources = (body: unknown, origin?: string) =>
      submit(body, origin, 'sources')
    getSession.mockResolvedValue(null)
    expect((await sources(request)).status).toBe(401)
    getSession.mockResolvedValue({
      user: { id: 'fixture-owner', email: 'owner@example.test' },
      session: { userId: 'fixture-owner', id: 'fixture-session' },
    })
    expect((await sources(request, 'https://other.example')).status).toBe(403)
    for (const invalid of [
      { ...film, sort: 'year' },
      { ...film, limit: 5 },
      { ...film, minPlays: 1 },
      { ...film, ranges: [range, range] },
      { ...film, ranges: [{ ...range, first: 4 }] },
      { ...film, ranges: [{ ...range, last: 5 }] },
      { ...film, ranges: [{ ...range, dimension: 'native.' }] },
      { ...film, yearFrom: 2020, yearTo: 2010 },
    ])
      expect((await sources(invalid)).status).toBe(422)
    expect(
      (await sources({ ...film, search: 'x'.repeat(32 * 1024) })).status,
    ).toBe(413)
    expect(summarizeRatingsSources).not.toHaveBeenCalled()
    const summary = { total: 0, sources: [], coverage: [], histograms: [] }
    summarizeRatingsSources.mockResolvedValue(summary)
    const response = await sources(request)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(await response.json()).toMatchObject({ data: summary })
    expect(summarizeRatingsSources).toHaveBeenCalledExactlyOnceWith(request)
  })
})
