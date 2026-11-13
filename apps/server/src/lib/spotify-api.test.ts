import { describe, expect, it, vi } from 'vitest'
import {
  SpotifyEpisodesPageSchema,
  SpotifySavedShowsPageSchema,
  normalizeSpotifyEpisode,
  normalizeSpotifyShow,
  normalizeSpotifyTrackEntry,
  spotifyJson,
  spotifyTrackAdditions,
  type SpotifyRequest,
} from './spotify-api'

const TRACK_ID = 'T'.repeat(22)
const ALBUM_ID = 'A'.repeat(22)

function track(overrides: Record<string, unknown> = {}) {
  return {
    type: 'track',
    id: TRACK_ID,
    name: 'Night Drive',
    duration_ms: 215_499,
    artists: [
      { name: 'The Examples' },
      { name: 'Example Singer' },
      { name: 'The Examples' },
    ],
    album: {
      id: ALBUM_ID,
      name: 'Example Album',
      release_date: '2019-03-01',
      images: [{ url: 'https://images.example.test/cover.jpg' }],
    },
    external_ids: { isrc: ' usabc1900001 ' },
    ...overrides,
  }
}

describe('normalizeSpotifyTrackEntry', () => {
  it('reads a playlist entry', () => {
    expect(
      normalizeSpotifyTrackEntry({
        added_at: '2024-05-06T07:08:09Z',
        item: track(),
      }),
    ).toEqual({
      track: {
        spotifyTrackId: TRACK_ID,
        title: 'Night Drive',
        artists: ['The Examples', 'Example Singer'],
        durationSec: 215,
        albumName: 'Example Album',
        spotifyAlbumId: ALBUM_ID,
        artworkUrl: 'https://images.example.test/cover.jpg',
        releaseDate: '2019-03-01',
        isrc: 'USABC1900001',
        addedAt: '2024-05-06T07:08:09Z',
      },
    })
  })

  it('reads a saved track from the older `track` field', () => {
    const result = normalizeSpotifyTrackEntry({ track: track() })
    expect(result.track?.spotifyTrackId).toBe(TRACK_ID)
  })

  it('keeps a track whose album details are missing or unusable', () => {
    const result = normalizeSpotifyTrackEntry({
      // Spotify reports the Unix epoch for entries older than the field.
      added_at: '1970-01-01T00:00:00Z',
      item: track({
        album: { id: 'not-an-id', name: '', release_date: '0000', images: [] },
        external_ids: undefined,
      }),
    })
    expect(result.track).toMatchObject({
      albumName: null,
      spotifyAlbumId: null,
      artworkUrl: null,
      releaseDate: null,
      isrc: null,
      addedAt: null,
    })
  })

  it.each([
    { name: 'a local file', entry: { is_local: true, item: track() } },
    { name: 'an episode', entry: { item: track({ type: 'episode' }) } },
    { name: 'a removed track', entry: { item: null } },
    { name: 'a track without an ID', entry: { item: track({ id: null }) } },
    { name: 'a track without a title', entry: { item: track({ name: '' }) } },
  ])('skips $name', ({ entry }) => {
    expect(normalizeSpotifyTrackEntry(entry)).toEqual({
      track: null,
      reason: 'skipped',
    })
  })

  it.each([
    { name: 'an unrecognised ID', overrides: { id: 'short' } },
    { name: 'no artists', overrides: { artists: [] } },
    { name: 'no duration', overrides: { duration_ms: undefined } },
  ])('reports a track with $name as invalid', ({ overrides }) => {
    expect(normalizeSpotifyTrackEntry({ item: track(overrides) })).toEqual({
      track: null,
      reason: 'invalid',
    })
  })
})

describe('spotifyTrackAdditions', () => {
  const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map((letter) =>
    letter.repeat(22),
  )
  const uri = (id: string | undefined) => `spotify:track:${id}`

  it('keeps album order, drops tracks already present and repeats, and splits requests', () => {
    const album = [a, b, a, c, d, e].flatMap((id) => (id ? [id] : []))
    expect(spotifyTrackAdditions(album, new Set(b ? [b] : []), 2)).toEqual([
      [uri(a), uri(c)],
      [uri(d), uri(e)],
    ])
  })

  it('sends nothing when every track is present', () => {
    const album = [a, b].flatMap((id) => (id ? [id] : []))
    expect(spotifyTrackAdditions(album, new Set(album))).toEqual([])
  })

  it('uses requests of 100 by default', () => {
    const many = Array.from({ length: 250 }, (_, index) =>
      `t${String(index).padStart(3, '0')}`.padEnd(22, 'x'),
    )
    expect(
      spotifyTrackAdditions(many, new Set()).map((batch) => batch.length),
    ).toEqual([100, 100, 50])
  })
})

const SHOW_ID = 'S'.repeat(22)
const EPISODE_ID = 'E'.repeat(22)

function episode(overrides: Record<string, unknown> = {}) {
  return {
    id: EPISODE_ID,
    name: 'Orbits for beginners',
    description: 'Transfer orbits without the maths.',
    html_description: '<p>Transfer orbits without the maths.</p>',
    duration_ms: 1_799_500,
    release_date: '2026-03-02',
    release_date_precision: 'day',
    images: [{ url: 'https://images.example.test/episode.jpg' }],
    explicit: false,
    is_playable: true,
    languages: ['en'],
    type: 'episode',
    ...overrides,
  }
}

const page = (items: unknown[]) => ({
  href: 'https://api.spotify.com/v1/shows/x/episodes',
  limit: 50,
  offset: 0,
  previous: null,
  next: null,
  total: items.length,
  items,
})

function parsedEpisode(overrides: Record<string, unknown> = {}) {
  const item = SpotifyEpisodesPageSchema.parse(page([episode(overrides)]))
    .items[0]
  if (!item) throw new Error('Missing episode')
  return item
}

describe('Spotify podcast pages', () => {
  it('reads a saved podcast and skips empty entries', () => {
    const parsed = SpotifySavedShowsPageSchema.parse(
      page([
        {
          added_at: '2026-01-01T00:00:00Z',
          show: {
            id: SHOW_ID,
            name: ' Orbit Talk\u0000 ',
            description: 'A show about orbits.',
            html_description: '<p>A show about orbits.</p>',
            images: [
              { url: 'https://images.example.test/show.jpg', height: 640 },
            ],
            total_episodes: 12,
            media_type: 'audio',
            explicit: false,
            languages: ['en'],
            is_externally_hosted: false,
          },
        },
        null,
        { added_at: '2026-01-01T00:00:00Z', show: null },
      ]),
    )
    expect(parsed.items.map(normalizeSpotifyShow)).toEqual([
      {
        id: SHOW_ID,
        title: 'Orbit Talk',
        description: 'A show about orbits.',
        thumbnailUrl: 'https://images.example.test/show.jpg',
        itemTotal: 12,
      },
      null,
      null,
    ])
  })

  it('rejects a page with a malformed podcast or more than 50 entries', () => {
    const show = { id: SHOW_ID, name: 'Orbit Talk', images: [] }
    expect(
      SpotifySavedShowsPageSchema.safeParse(page([{ show }])).success,
    ).toBe(false)
    expect(
      SpotifyEpisodesPageSchema.safeParse(page(Array(51).fill(null))).success,
    ).toBe(false)
    expect(
      SpotifyEpisodesPageSchema.safeParse(page([episode({ id: 'short' })]))
        .success,
    ).toBe(false)
    expect(
      SpotifyEpisodesPageSchema.safeParse(
        page([episode({ release_date_precision: 'minute' })]),
      ).success,
    ).toBe(false)
    expect(
      SpotifyEpisodesPageSchema.safeParse(
        page([episode({ release_date: '2026-02-30' })]),
      ).success,
    ).toBe(false)
  })

  it('reads an episode with an empty entry beside it', () => {
    const parsed = SpotifyEpisodesPageSchema.parse(page([null, episode()]))
    expect(parsed.items[0]).toBeNull()
    const item = parsed.items[1]
    if (!item) throw new Error('Missing episode')
    expect(normalizeSpotifyEpisode(item)).toEqual({
      id: EPISODE_ID,
      title: 'Orbits for beginners',
      description: 'Transfer orbits without the maths.',
      durationSec: 1800,
      publishedAt: new Date('2026-03-02T00:00:00.000Z'),
      publishedPrecision: 'day',
      artworkUrl: 'https://images.example.test/episode.jpg',
    })
  })

  it.each([
    ['2021', 'year', '2021-01-01', 'year'],
    ['2022-05', 'month', '2022-05-01', 'month'],
    ['2023-02-14', 'day', '2023-02-14', 'day'],
    // Spotify's precision is used when the date carries more detail.
    ['2023-02-14', 'month', '2023-02-01', 'month'],
    ['2023-02-14', 'year', '2023-01-01', 'year'],
    // A date shorter than its stated precision keeps its own.
    ['2024-03', 'day', '2024-03-01', 'month'],
    ['2024', 'day', '2024-01-01', 'year'],
  ])(
    'stores %s with %s precision as %s (%s)',
    (date, precision, day, stored) => {
      expect(
        normalizeSpotifyEpisode(
          parsedEpisode({
            release_date: date,
            release_date_precision: precision,
          }),
        ),
      ).toMatchObject({
        publishedAt: new Date(`${day}T00:00:00.000Z`),
        publishedPrecision: stored,
      })
    },
  )

  it('fills in a missing title, description and artwork', () => {
    expect(
      normalizeSpotifyEpisode(
        parsedEpisode({
          name: ' ',
          description: null,
          images: [{ url: 'http://images.example.test/plain.jpg' }],
        }),
      ),
    ).toMatchObject({
      title: 'Untitled episode',
      description: '',
      artworkUrl: null,
    })
  })
})

describe('spotifyJson', () => {
  it('passes the not-found option to the request gate', async () => {
    const request = vi.fn<SpotifyRequest>(async () => Response.json({}))
    await spotifyJson(
      request,
      'token',
      `shows/${SHOW_ID}/episodes`,
      { offset: '50' },
      { notFoundOn404: true },
    )
    expect(request).toHaveBeenCalledWith(
      new URL(`https://api.spotify.com/v1/shows/${SHOW_ID}/episodes?offset=50`),
      { headers: { Authorization: 'Bearer token' } },
      { notFoundOn404: true },
    )
  })
})
