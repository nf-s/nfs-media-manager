import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  layout: vi.fn(),
}))
vi.mock('@/env', () => ({
  env: {
    TRUSTED_ORIGINS: ['http://localhost:3001'],
    NODE_ENV: 'test',
    OWNER_EMAIL: 'owner@example.com',
  },
}))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.session } } }))
vi.mock('@/services/track-duplicates', () => ({
  countTrackDuplicateGroups: vi.fn(),
  keepTracksSeparate: vi.fn(),
  listTrackDuplicates: vi.fn(),
  readTrackDuplicateLayout: mocks.layout,
}))
import { ServerError } from '@/lib/error'
import { trackDuplicates } from '../track-duplicates'

const app = new Hono()
app.route('/', trackDuplicates)
app.onError((error, c) =>
  error instanceof ServerError
    ? c.json(error.response, error.response.statusCode)
    : c.json({ message: 'Failed' }, 500),
)

describe('track duplicates API', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Live requests forbidden')
      }),
    )
    mocks.session.mockResolvedValue({
      user: { id: 'user-1', email: 'owner@example.com', role: 'admin' },
      session: { id: 'session-1', userId: 'user-1' },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reads the layout for the Matches query of the owner', async () => {
    mocks.session.mockResolvedValueOnce(null)
    expect((await app.request('/duplicates/layout')).status).toBe(401)
    for (const query of ['size=101', 'playability=fixture', 'view=fixture'])
      expect((await app.request(`/duplicates/layout?${query}`)).status).toBe(
        422,
      )
    expect(mocks.layout).not.toHaveBeenCalled()

    const layout = { totalRows: 0, groups: [] }
    mocks.layout.mockResolvedValueOnce(layout)
    const filters = [{ field: 'title', value: 'Fixture', mode: 'exclude' }]
    const params = new URLSearchParams({
      q: 'fixture',
      sortBy: 'creator',
      playability: 'direct',
      view: 'providers',
      limitResults: '40',
      filters: JSON.stringify(filters),
    })
    const response = await app.request(`/duplicates/layout?${params}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: layout })
    expect(mocks.layout).toHaveBeenCalledWith(
      expect.objectContaining({
        q: 'fixture',
        sortBy: 'creator',
        playability: 'direct',
        view: 'providers',
        limitResults: 40,
        filters,
      }),
      'user-1',
    )
  })
})
