import { describe, expect, it } from 'vitest'
import { ProviderItemNotFoundError } from '@repo/media-plugin-sdk'
import { createNtsAdapter, NTS_FEED_MAX_OFFSET } from './nts-api'
import type { StationRequest } from './mix-station'

const NOW = new Date('2030-06-15T12:00:00Z')
const API = 'https://www.nts.live/api/v2/'

type Call = { url: string; notFoundOn404: boolean }

/** A request gate answering the listed URLs; any other URL is an HTTP 404. */
function fakeRequest(responses: Record<string, unknown>) {
  const calls: Call[] = []
  const request: StationRequest = async (url, _init, options) => {
    const href = url.toString()
    const notFoundOn404 = options?.notFoundOn404 === true
    calls.push({ url: href, notFoundOn404 })
    if (href in responses)
      return new Response(JSON.stringify(responses[href]), { status: 200 })
    if (notFoundOn404) throw new ProviderItemNotFoundError('Not found')
    return new Response('{}', { status: 404 })
  }
  return { request, calls }
}

function envelope(results: unknown[], count: number, offset = 0) {
  return { metadata: { resultset: { count, offset, limit: 12 } }, results }
}

function show(overrides: Record<string, unknown> = {}) {
  return {
    status: 'published',
    updated: '2030-01-01T00:00:00+00:00',
    name: 'Fixture Hour  ',
    description: 'A synthetic show.',
    description_html: '<p>A synthetic show.</p>',
    external_links: [],
    moods: [{ id: 'mood-1', value: 'Late Night' }],
    genres: [{ id: 'genre-1', value: 'Ambient' }],
    location_short: 'LDN',
    location_long: 'London',
    media: {
      picture_large: 'https://media.example.test/fixture-large.jpg',
      picture_medium_large:
        'https://media.example.test/fixture-medium-large.jpg',
      picture_medium: 'https://media.example.test/fixture-medium.jpg',
    },
    show_alias: 'fixture-hour',
    type: 'show',
    ...overrides,
  }
}

function episode(overrides: Record<string, unknown> = {}) {
  return {
    status: 'published',
    updated: '2030-06-02T00:00:00+00:00',
    name: 'Fixture Hour w/ Guest One & Guest Two',
    description: 'Two invented guests.',
    moods: [{ id: 'mood-1', value: 'Late Night' }],
    genres: [
      { id: 'genre-1', value: 'Ambient' },
      { id: 'genre-2', value: 'Dub' },
      { id: 'genre-3', value: 'ambient' },
    ],
    location_long: 'London',
    episode_alias: 'fixture-hour-1st-june-2030',
    show_alias: 'fixture-hour',
    broadcast: '2030-06-01T21:00:00+01:00',
    audio_sources: [
      {
        url: 'https://soundcloud.example.test/fixture/episode-1?utm_source=api&utm_medium=x#t=1',
        source: 'soundcloud',
      },
    ],
    media: {
      picture_large: 'https://media.example.test/episode-large.jpg',
      picture_medium_large: '',
      picture_medium: 'https://media.example.test/episode-medium.jpg',
    },
    ...overrides,
  }
}

const adapter = createNtsAdapter(() => NOW)

function catalogue() {
  const value = adapter.catalogue
  if (!value) throw new Error('NTS has a catalogue.')
  return value
}

function getShow() {
  const value = adapter.getShow
  if (!value) throw new Error('NTS reads single shows.')
  return value
}

describe('listShows', () => {
  it('pages shows by offset, trims names and skips unpublished shows', async () => {
    const { request, calls } = fakeRequest({
      [`${API}shows?offset=0&limit=12`]: envelope(
        [show(), show({ status: 'draft', show_alias: 'hidden-show' })],
        30,
      ),
      [`${API}shows?offset=12&limit=12`]: envelope(
        [show({ show_alias: 'second-show', description: '', media: {} })],
        30,
        12,
      ),
      [`${API}shows?offset=24&limit=12`]: envelope([show()], 30, 24),
    })
    const first = await catalogue().listShows(request, null)
    expect(first).toEqual({
      entries: [
        {
          id: 'nts.fixture-hour',
          handle: 'fixture-hour',
          title: 'Fixture Hour',
          description: 'A synthetic show.',
          thumbnailUrl: 'https://media.example.test/fixture-medium-large.jpg',
          url: 'https://www.nts.live/shows/fixture-hour',
          itemTotal: null,
        },
      ],
      next: '12',
      total: 30,
    })
    const second = await catalogue().listShows(request, first.next)
    expect(second.entries[0]).toMatchObject({
      id: 'nts.second-show',
      description: null,
      thumbnailUrl: null,
    })
    expect(second.next).toBe('24')
    expect((await catalogue().listShows(request, '24')).next).toBeNull()
    expect(calls.map((call) => call.url)).toEqual([
      `${API}shows?offset=0&limit=12`,
      `${API}shows?offset=12&limit=12`,
      `${API}shows?offset=24&limit=12`,
    ])
  })

  it('ends at an empty page and skips unusable aliases', async () => {
    const { request } = fakeRequest({
      [`${API}shows?offset=0&limit=12`]: envelope(
        [show({ show_alias: 'bad alias!' }), show({ show_alias: null })],
        100,
      ),
      [`${API}shows?offset=12&limit=12`]: envelope([], 100, 12),
    })
    expect(await catalogue().listShows(request, null)).toMatchObject({
      entries: [],
      next: '12',
    })
    expect((await catalogue().listShows(request, '12')).next).toBeNull()
  })

  it('rejects an invalid payload or page token', async () => {
    const { request } = fakeRequest({
      [`${API}shows?offset=0&limit=12`]: { results: [show()] },
    })
    await expect(catalogue().listShows(request, null)).rejects.toThrow()
    await expect(catalogue().listShows(request, 'abc')).rejects.toThrow(
      'Invalid NTS page token.',
    )
  })
})

describe('listShowEpisodes', () => {
  const target = { id: 'nts.fixture-hour', handle: 'fixture-hour' }
  const firstPage = `${API}shows/fixture-hour/episodes?offset=0&limit=12`

  it('maps an episode', async () => {
    const { request, calls } = fakeRequest({
      [firstPage]: envelope([episode()], 13),
    })
    const page = await catalogue().listShowEpisodes(request, target, null)
    expect(page).toEqual({
      entries: [
        {
          id: 'nts.fixture-hour.fixture-hour-1st-june-2030',
          title: 'Fixture Hour w/ Guest One & Guest Two',
          description: 'Two invented guests.',
          url: 'https://www.nts.live/shows/fixture-hour/episodes/fixture-hour-1st-june-2030',
          audioUrl: 'https://soundcloud.example.test/fixture/episode-1',
          artworkUrl: 'https://media.example.test/episode-large.jpg',
          publishedAt: new Date('2030-06-01T20:00:00Z'),
          durationSec: null,
          artists: ['Guest One', 'Guest Two'],
          tags: ['Ambient', 'Dub'],
        },
      ],
      next: '12',
      total: 13,
    })
    expect(calls).toEqual([{ url: firstPage, notFoundOn404: true }])
  })

  it('reads names without guests and falls back for audio and artwork', async () => {
    const { request } = fakeRequest({
      [firstPage]: envelope(
        [
          episode({
            name: 'Fixture Hour  ',
            description: null,
            audio_sources: [],
            mixcloud:
              'https://mixcloud.example.test/fixture/legacy/?utm_campaign=x',
            media: {
              picture_medium: 'https://media.example.test/only-medium.jpg',
            },
          }),
          episode({
            episode_alias: 'no-audio',
            name: 'FIXTURE HOUR W/ Solo Guest',
            audio_sources: null,
            media: null,
          }),
        ],
        2,
      ),
    })
    const page = await catalogue().listShowEpisodes(request, target, null)
    expect(page.next).toBeNull()
    expect(page.entries).toMatchObject([
      {
        title: 'Fixture Hour',
        description: '',
        audioUrl: 'https://mixcloud.example.test/fixture/legacy/',
        artworkUrl: 'https://media.example.test/only-medium.jpg',
        artists: [],
      },
      {
        id: 'nts.fixture-hour.no-audio',
        audioUrl: null,
        artworkUrl: null,
        artists: ['Solo Guest'],
      },
    ])
  })

  it('skips unpublished, undated, future and unusable episodes', async () => {
    const { request } = fakeRequest({
      [firstPage]: envelope(
        [
          episode({ status: 'draft' }),
          episode({ broadcast: null }),
          episode({ broadcast: 'not a date' }),
          episode({ broadcast: '2030-07-01T00:00:00Z' }),
          episode({ episode_alias: 'bad alias!' }),
          episode({ episode_alias: null }),
        ],
        6,
      ),
    })
    const page = await catalogue().listShowEpisodes(request, target, null)
    expect(page).toEqual({ entries: [], next: null, total: 6 })
  })

  it('pages by offset', async () => {
    const { request, calls } = fakeRequest({
      [`${API}shows/fixture-hour/episodes?offset=12&limit=12`]: envelope(
        [episode()],
        25,
        12,
      ),
    })
    const page = await catalogue().listShowEpisodes(request, target, '12')
    expect(page.next).toBe('24')
    expect(calls[0]?.url).toBe(
      `${API}shows/fixture-hour/episodes?offset=12&limit=12`,
    )
  })

  it('returns an empty last page for a removed show', async () => {
    const { request } = fakeRequest({})
    expect(
      await catalogue().listShowEpisodes(
        request,
        { id: 'nts.removed-show', handle: 'removed-show' },
        null,
      ),
    ).toEqual({ entries: [], next: null, total: null })
  })

  it('rejects an invalid payload', async () => {
    const { request } = fakeRequest({
      [firstPage]: envelope([{ ...episode(), broadcast: 42 }], 1),
    })
    await expect(
      catalogue().listShowEpisodes(request, target, null),
    ).rejects.toThrow()
  })
})

describe('listFeed', () => {
  const feedUrl = (offset: number) =>
    `${API}collections/recently-added?offset=${offset}&limit=12`

  it('names each show partially from the episode', async () => {
    const { request } = fakeRequest({
      [feedUrl(0)]: envelope(
        [
          episode(),
          episode({
            show_alias: 'other-show',
            episode_alias: 'other-show-1',
            name: ' Other Show ',
          }),
          episode({ show_alias: 'bad alias!' }),
        ],
        90_000,
      ),
    })
    const page = await adapter.listFeed(request, 'recent', null, null)
    expect(page.entries.map((entry) => entry.show)).toEqual([
      {
        id: 'nts.fixture-hour',
        handle: 'fixture-hour',
        title: 'Fixture Hour',
        description: null,
        thumbnailUrl: null,
        url: 'https://www.nts.live/shows/fixture-hour',
        itemTotal: null,
      },
      {
        id: 'nts.other-show',
        handle: 'other-show',
        title: 'Other Show',
        description: null,
        thumbnailUrl: null,
        url: 'https://www.nts.live/shows/other-show',
        itemTotal: null,
      },
    ])
    expect(page.entries.every((entry) => entry.showPartial)).toBe(true)
    expect(page.entries[0]?.episode.id).toBe(
      'nts.fixture-hour.fixture-hour-1st-june-2030',
    )
    expect(page).toMatchObject({ next: '12', total: 90_000, truncated: false })
  })

  it('stops when every episode was broadcast over 3 days before since', async () => {
    const since = new Date('2030-06-14T00:00:00Z')
    const { request } = fakeRequest({
      [feedUrl(12)]: envelope(
        [
          episode({ broadcast: '2030-06-11T01:00:00Z' }),
          episode({ broadcast: '2030-06-06T00:00:00Z' }),
        ],
        90_000,
        12,
      ),
      [feedUrl(24)]: envelope(
        [
          episode({ broadcast: '2030-06-10T00:00:00Z' }),
          episode({ broadcast: '2030-06-06T00:00:00Z' }),
        ],
        90_000,
        24,
      ),
    })
    expect(
      await adapter.listFeed(request, 'recent', '12', since),
    ).toMatchObject({ next: '24', truncated: false })
    const last = await adapter.listFeed(request, 'archive', '24', since)
    expect(last).toMatchObject({ next: null, truncated: false })
    expect(last.entries).toHaveLength(2)
  })

  it('stops at an empty page', async () => {
    const { request } = fakeRequest({ [feedUrl(36)]: envelope([], 40, 36) })
    expect(await adapter.listFeed(request, 'recent', '36', NOW)).toEqual({
      entries: [],
      next: null,
      total: 40,
      truncated: false,
    })
  })

  it('reports truncation at the paging limit, also with no start', async () => {
    const { request } = fakeRequest({
      [feedUrl(NTS_FEED_MAX_OFFSET - 12)]: envelope([episode()], 90_000),
      [feedUrl(NTS_FEED_MAX_OFFSET)]: envelope([episode()], 90_000),
    })
    expect(
      await adapter.listFeed(
        request,
        'archive',
        String(NTS_FEED_MAX_OFFSET - 12),
        null,
      ),
    ).toMatchObject({ next: String(NTS_FEED_MAX_OFFSET), truncated: false })
    for (const since of [null, new Date('2030-06-01T00:00:00Z')]) {
      expect(
        await adapter.listFeed(
          request,
          'recent',
          String(NTS_FEED_MAX_OFFSET),
          since,
        ),
      ).toMatchObject({ next: null, truncated: true })
    }
  })

  it('ends without truncation at the end of a short listing', async () => {
    const { request } = fakeRequest({ [feedUrl(0)]: envelope([episode()], 1) })
    expect(
      await adapter.listFeed(request, 'archive', null, null),
    ).toMatchObject({ next: null, truncated: false })
  })

  it('rejects an invalid payload', async () => {
    const { request } = fakeRequest({
      [feedUrl(0)]: { metadata: { resultset: { count: 'many' } }, results: [] },
    })
    await expect(
      adapter.listFeed(request, 'recent', null, null),
    ).rejects.toThrow()
  })
})

describe('getShow', () => {
  it('reads a show', async () => {
    const { request, calls } = fakeRequest({
      [`${API}shows/fixture-hour`]: show(),
    })
    expect(await getShow()(request, 'fixture-hour')).toMatchObject({
      id: 'nts.fixture-hour',
      title: 'Fixture Hour',
    })
    expect(calls).toEqual([
      { url: `${API}shows/fixture-hour`, notFoundOn404: true },
    ])
  })

  it('returns null for a missing or unpublished show', async () => {
    const { request } = fakeRequest({
      [`${API}shows/hidden-show`]: show({
        status: 'draft',
        show_alias: 'hidden-show',
      }),
    })
    expect(await getShow()(request, 'missing-show')).toBeNull()
    expect(await getShow()(request, 'hidden-show')).toBeNull()
  })

  it('rejects an invalid payload', async () => {
    const { request } = fakeRequest({
      [`${API}shows/fixture-hour`]: { ...show(), name: ['not', 'a', 'name'] },
    })
    await expect(getShow()(request, 'fixture-hour')).rejects.toThrow()
  })
})
