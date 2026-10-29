import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ states: vi.fn() }))
vi.mock('@/lib/db', () => ({
  db: { select: () => ({ from: () => ({ where: mocks.states }) }) },
}))
import { getAlbumProviderDetails } from '../album-provider-details'

describe('stored album provider details', () => {
  afterEach(() => {
    vi.resetAllMocks()
    vi.unstubAllGlobals()
  })

  it('reads one bounded query and ignores malformed and unrelated states without fetching', async () => {
    const fetch = vi.fn(() => {
      throw new Error('Unexpected network request')
    })
    vi.stubGlobal('fetch', fetch)
    mocks.states.mockResolvedValue([
      { provider: 'discogs', payload: { unexpected: true } },
      { provider: 'spotify', payload: {} },
      {
        provider: 'lastfm',
        payload: {
          album: {
            name: 'Example',
            artist: 'Artist',
            url: 'https://www.last.fm/music/Artist/Example',
            wiki: { summary: 'Stored album notes' },
          },
        },
      },
    ])
    const result = await getAlbumProviderDetails('album-example')
    expect(result.map((item) => item.provider)).toEqual(['lastfm'])
    expect(result[0]?.notes).toContainEqual({
      label: 'Wiki summary',
      text: 'Stored album notes',
    })
    expect(mocks.states).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns no details when no stored provider payload exists', async () => {
    mocks.states.mockResolvedValue([])
    expect(await getAlbumProviderDetails('album-empty')).toEqual([])
  })
})
