import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ states: vi.fn() }))
vi.mock('@/lib/db', () => ({
  db: { select: () => ({ from: () => ({ where: mocks.states }) }) },
}))
import { withStoredTrailerLinks } from '../stored-trailers'

describe('offline trailer links', () => {
  afterEach(() => vi.resetAllMocks())
  it('batches only missing items and returns safe links without mutating inputs', async () => {
    const items = [
      { id: 'one', links: [] },
      { id: 'two', links: [] },
    ]
    mocks.states.mockResolvedValue([
      {
        mediaItemId: 'one',
        provider: 'nfo',
        payload: {
          trailer: [
            'plugin://plugin.video.youtube/?action=play_video&videoid=Abc_123-xyz',
          ],
        },
      },
      {
        mediaItemId: 'two',
        provider: 'mdblist',
        payload: { trailer: 'javascript:alert(1)' },
      },
      {
        mediaItemId: 'two',
        provider: 'other',
        payload: { trailer: 'https://youtu.be/Abc_123-xyz' },
      },
    ])
    const result = await withStoredTrailerLinks(items)
    expect(mocks.states).toHaveBeenCalledTimes(1)
    expect(result[0]?.links).toEqual([
      {
        provider: 'youtube-trailer',
        label: 'YouTube trailer',
        url: 'https://www.youtube.com/watch?v=Abc_123-xyz',
      },
    ])
    expect(result[1]?.links).toEqual([])
    expect(items[0]?.links).toEqual([])
  })
  it('skips empty pages and already linked trailers', async () => {
    expect(await withStoredTrailerLinks([])).toEqual([])
    const items = [
      {
        id: 'one',
        links: [
          {
            provider: 'youtube-trailer',
            label: 'Trailer',
            url: 'https://youtu.be/Abc_123-xyz',
          },
        ],
      },
    ]
    expect(await withStoredTrailerLinks(items)).toBe(items)
    expect(mocks.states).not.toHaveBeenCalled()
  })
})
