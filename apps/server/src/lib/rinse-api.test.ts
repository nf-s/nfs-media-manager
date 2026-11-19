import { describe, expect, it } from 'vitest'
import { ProviderItemNotFoundError } from '@repo/media-plugin-sdk'
import {
  RinseSchedulePageSchema,
  RinseShowPageSchema,
  createRinseAdapter,
} from './rinse-api'
import type { MixStationAdapter, StationRequest } from './mix-station'

const API = 'https://www.rinse.fm/api/query/v1'
const NOW = new Date('2026-11-19T12:00:00.000Z')

function fakeRequest(routes: Record<string, unknown>) {
  const calls: string[] = []
  const request: StationRequest = async (url, _init, options) => {
    const href = String(url)
    calls.push(href)
    if (!(href in routes)) {
      if (options?.notFoundOn404)
        throw new ProviderItemNotFoundError('Not found')
      return new Response('', { status: 404 })
    }
    return new Response(JSON.stringify(routes[href]))
  }
  return { request, calls }
}

function adapter() {
  return createRinseAdapter(() => NOW)
}

function catalogue(station: MixStationAdapter) {
  if (!station.catalogue) throw new Error('Rinse has a catalogue')
  return station.catalogue
}

function show(overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'show_show_Entry',
    id: '501',
    slug: 'night-example',
    title: 'Night Example',
    showStatus: 'highlighted',
    extract: 'A synthetic show.',
    featuredImage: [{ filename: 'night example.jpg', width: 800, height: 800 }],
    defaultEpisodeImage: [{ filename: 'night-default.jpg' }],
    genreTag: [{ slug: 'jungle', title: 'Jungle' }],
    channel: [{ slug: 'uk', title: 'UK' }],
    ...overrides,
  }
}

function episode(overrides: Record<string, unknown> = {}) {
  return {
    id: '9001',
    slug: 'night-example-17-11-2026-2100',
    title: 'Night Example - 17/11/2026 - 21:00',
    artistTitle: null,
    displayTitle: null,
    subtitle: null,
    extract: 'An invented episode.',
    episodeDate: '2026-11-17T00:00:00+00:00',
    episodeTime: '2026-11-19T21:00:00+00:00',
    episodeLength: 60,
    fileUrl: 'https://replay.rinse.fm/uk/NightExample171126.mp3',
    youtubeStreamUrl: null,
    isRebroadcast: false,
    featuredImage: [],
    genreTag: [
      { slug: 'jungle', title: 'Jungle', isVisibleTag: true },
      { slug: 'jungle-2', title: 'jungle' },
      { slug: 'hidden', title: 'Hidden', isVisibleTag: false },
      { slug: 'dnb', title: 'Drum & Bass', isVisibleTag: true },
    ],
    channel: [
      { slug: 'uk', title: 'UK', defaultTimezoneOffset: 'Europe/London' },
    ],
    parentShow: [show()],
    ...overrides,
  }
}

describe('rinse catalogue', () => {
  it('reads shows by page index and stops after a short page', async () => {
    const full = Array.from({ length: 20 }, (_, index) =>
      show({ id: String(600 + index), slug: `show-${index}` }),
    )
    const { request, calls } = fakeRequest({
      [`${API}/shows/filter?offset=0`]: { entries: full },
      [`${API}/shows/filter?offset=1`]: {
        entries: [
          show({
            featuredImage: [],
            extract: '',
            description: '<p>Fold &amp; friends</p>',
          }),
          show({ id: 'not valid', slug: 'bad-id' }),
        ],
      },
    })
    const first = await catalogue(adapter()).listShows(request, null)
    expect(first).toMatchObject({ next: '1', total: null })
    expect(first.entries).toHaveLength(20)

    const last = await catalogue(adapter()).listShows(request, '1')
    expect(last).toEqual({
      entries: [
        {
          id: 'rinse.501',
          title: 'Night Example',
          handle: 'night-example',
          description: null,
          thumbnailUrl:
            'https://image.rinse.fm/_/night-default.jpg?w=800&h=800',
          url: 'https://www.rinse.fm/shows/night-example',
          itemTotal: null,
        },
      ],
      next: null,
      total: null,
    })
    expect(calls).toEqual([
      `${API}/shows/filter?offset=0`,
      `${API}/shows/filter?offset=1`,
    ])
  })

  it('maps a show and its stored-eligible episodes newest first', async () => {
    const { request, calls } = fakeRequest({
      [`${API}/shows/night-example`]: {
        entry: {
          ...show({ extract: null }),
          description: '<p>Line one</p><p>Line &amp; two</p>',
        },
        episodes: [
          episode({
            id: '9002',
            slug: 'night-example-13-07-2026-1800',
            episodeDate: '2026-07-12T23:00:00+00:00',
            episodeTime: '2026-11-19T18:00:00+00:00',
            fileUrl: null,
            youtubeStreamUrl: 'https://www.youtube.com/watch?v=example0001',
            displayTitle: 'presents Flight:Mode 014',
          }),
          episode({ artistTitle: 'DJ Alpha B2B Beta & Gamma' }),
          episode({ id: '9003', fileUrl: null, youtubeStreamUrl: null }),
          episode({ id: '9004', fileUrl: 'https://replay.rinse.fm/uk/' }),
          episode({ id: '9005', isRebroadcast: true }),
          episode({ id: '9006', fileUrl: 'https://replay.rinse.fm/uk/X.MP3' }),
        ],
      },
    })
    const page = await catalogue(adapter()).listShowEpisodes(
      request,
      { id: 'rinse.501', handle: 'night-example' },
      null,
    )
    expect(calls).toEqual([`${API}/shows/night-example`])
    expect(page.next).toBeNull()
    expect(page.total).toBe(3)
    expect(page.entries.map((entry) => entry.id)).toEqual([
      'rinse.9001',
      'rinse.9006',
      'rinse.9002',
    ])
    expect(page.entries[0]).toEqual({
      id: 'rinse.9001',
      title: 'DJ Alpha B2B Beta & Gamma',
      description: 'An invented episode.',
      url: 'https://www.rinse.fm/episodes/night-example-17-11-2026-2100',
      audioUrl: 'https://replay.rinse.fm/uk/NightExample171126.mp3',
      artworkUrl: 'https://image.rinse.fm/_/night%20example.jpg?w=800&h=800',
      publishedAt: new Date('2026-11-17T21:00:00.000Z'),
      durationSec: 3600,
      artists: ['DJ Alpha', 'Beta', 'Gamma'],
      tags: ['Jungle', 'Drum & Bass'],
    })
    expect(page.entries[2]).toMatchObject({
      title: 'Night Example presents Flight:Mode 014',
      audioUrl: 'https://www.youtube.com/watch?v=example0001',
      artists: ['Night Example'],
      // 18:00 on 13 July in London is 17:00 UTC.
      publishedAt: new Date('2026-07-13T17:00:00.000Z'),
    })
  })

  it('uses the subtitle, the episode artwork and the channel time zone', async () => {
    const { request } = fakeRequest({
      [`${API}/shows/night-example`]: {
        entry: show(),
        episodes: [
          episode({
            subtitle: 'Live from Example Hall',
            featuredImage: [{ filename: 'episode.jpg' }],
            episodeDate: '2026-07-12T22:00:00+00:00',
            episodeTime: '2026-11-19T20:00:00+00:00',
            episodeLength: null,
            channel: [{ slug: 'fr', defaultTimezoneOffset: 'Europe/Paris' }],
          }),
          episode({
            id: '9010',
            episodeDate: '2026-01-05T00:00:00+00:00',
            episodeTime: null,
          }),
        ],
      },
    })
    const page = await catalogue(adapter()).listShowEpisodes(
      request,
      { id: 'rinse.501', handle: 'night-example' },
      null,
    )
    expect(page.entries[0]).toMatchObject({
      title: 'Night Example Live from Example Hall',
      artworkUrl: 'https://image.rinse.fm/_/episode.jpg?w=800&h=800',
      durationSec: null,
      // 20:00 on 13 July in Paris is 18:00 UTC.
      publishedAt: new Date('2026-07-13T18:00:00.000Z'),
    })
    expect(page.entries[1]?.publishedAt).toEqual(
      new Date('2026-01-05T00:00:00.000Z'),
    )
  })

  it('adds the guests a display title bills to the artists', async () => {
    const { request } = fakeRequest({
      [`${API}/shows/night-example`]: {
        entry: show(),
        episodes: [
          episode({
            artistTitle: 'DJ Alpha',
            displayTitle: 'with Guest One, Guest:Two & dj alpha',
          }),
        ],
      },
    })
    const page = await catalogue(adapter()).listShowEpisodes(
      request,
      { id: 'rinse.501', handle: 'night-example' },
      null,
    )
    expect(page.entries[0]).toMatchObject({
      title: 'DJ Alpha with Guest One, Guest:Two & dj alpha',
      artists: ['DJ Alpha', 'Guest One', 'Guest:Two'],
    })
  })

  it('returns an empty page for a removed show', async () => {
    const { request } = fakeRequest({})
    await expect(
      catalogue(adapter()).listShowEpisodes(
        request,
        { id: 'rinse.501', handle: 'gone-show' },
        null,
      ),
    ).resolves.toEqual({ entries: [], next: null, total: 0 })
  })
})

describe('rinse day feed', () => {
  it('starts 14 days before the last run and reads one day per page', async () => {
    const { request, calls } = fakeRequest({
      [`${API}/schedule/2026-10-27`]: {
        entries: [episode(), episode({ id: '9020', parentShow: [] })],
      },
    })
    const page = await adapter().listFeed(
      request,
      'recent',
      null,
      new Date('2026-11-10T08:00:00.000Z'),
    )
    expect(calls).toEqual([`${API}/schedule/2026-10-27`])
    expect(page).toMatchObject({
      next: '2026-10-28',
      total: null,
      truncated: false,
    })
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0]).toMatchObject({
      show: { id: 'rinse.501', handle: 'night-example' },
      showPartial: false,
      episode: { id: 'rinse.9001' },
    })
  })

  it('starts 14 days before now without a previous run', async () => {
    const { request, calls } = fakeRequest({
      [`${API}/schedule/2026-11-05`]: { entries: [] },
    })
    await adapter().listFeed(request, 'archive', null, null)
    expect(calls).toEqual([`${API}/schedule/2026-11-05`])
  })

  it('ends after reading today', async () => {
    const { request } = fakeRequest({
      [`${API}/schedule/2026-11-19`]: { entries: [] },
    })
    await expect(
      adapter().listFeed(request, 'recent', '2026-11-19', null),
    ).resolves.toEqual({
      entries: [],
      next: null,
      total: null,
      truncated: false,
    })
  })

  it('reports a start older than 60 days as truncated without a request', async () => {
    const { request, calls } = fakeRequest({})
    await expect(
      adapter().listFeed(
        request,
        'recent',
        null,
        new Date('2026-08-01T00:00:00.000Z'),
      ),
    ).resolves.toEqual({
      entries: [],
      next: null,
      total: null,
      truncated: true,
    })
    expect(calls).toEqual([])
  })

  it('rejects an invalid page token', async () => {
    const { request } = fakeRequest({})
    await expect(
      adapter().listFeed(request, 'recent', '2026-02-30', null),
    ).rejects.toThrow('Invalid Rinse feed page')
  })
})

describe('rinse payload validation', () => {
  it('rejects malformed pages', async () => {
    expect(RinseShowPageSchema.safeParse({ entries: 'none' }).success).toBe(
      false,
    )
    expect(
      RinseSchedulePageSchema.safeParse({ entries: [{ id: '1' }] }).success,
    ).toBe(false)
    expect(RinseSchedulePageSchema.parse({}).entries).toEqual([])

    const { request } = fakeRequest({
      [`${API}/shows/filter?offset=0`]: { entries: [{ title: 'No id' }] },
    })
    await expect(catalogue(adapter()).listShows(request, null)).rejects.toThrow(
      'Rinse returned an invalid response',
    )
  })
})
