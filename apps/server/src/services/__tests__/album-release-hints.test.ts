import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  tracks: vi.fn<() => Promise<{ title: string }[]>>(),
  snapshots: vi.fn<() => Promise<{ provider: string; payload: unknown }[]>>(),
  references: vi.fn<
    () => Promise<
      {
        provider: string
        referenceType: string
        externalId: string
        isPrimary: boolean
      }[]
    >
  >(),
  overrides:
    vi.fn<
      () => Promise<
        { provider: string; referenceType: string; externalId: string }[]
      >
    >(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      providerReference: { findMany: mocks.references },
      providerReferenceOverride: { findMany: mocks.overrides },
      providerSnapshot: { findMany: mocks.snapshots },
      track: { findMany: mocks.tracks },
    },
  },
}))

import { getAlbumReleaseHints } from '../album-release-hints'

const spotifyId = '1111111111111111111111'
const otherSpotifyId = '2222222222222222222222'
const releaseGroupId = '11111111-2222-4333-8444-555555555555'
const masterId = 123456
const master = {
  id: masterId,
  title: 'Fixture master',
  year: 1995,
  artists: [{ name: 'Fixture Writer (Fixture Alias)' }],
}
const masterReference = {
  provider: 'discogs',
  referenceType: 'master',
  externalId: String(masterId),
  isPrimary: true,
}
const spotifyRelease = {
  id: spotifyId,
  name: 'Fixture edition',
  release_date: '2003-03',
  album_type: 'compilation',
  artists: [{ name: 'Fixture artist' }],
}
const musicBrainzRelease = {
  id: releaseGroupId,
  title: 'Fixture release group',
  'first-release-date': '1999',
  'primary-type': 'Album',
  'artist-credit': [
    {
      name: 'Fixture credited artist',
      artist: { name: 'Fixture catalogue artist' },
    },
  ],
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.tracks.mockResolvedValue([])
  mocks.overrides.mockResolvedValue([])
  mocks.references.mockResolvedValue([
    {
      provider: 'spotify',
      referenceType: 'album',
      externalId: spotifyId,
      isPrimary: true,
    },
    {
      provider: 'musicbrainz',
      referenceType: 'release-group',
      externalId: releaseGroupId,
      isPrimary: true,
    },
  ])
  mocks.snapshots.mockResolvedValue([])
})

it('projects exactly linked release evidence from modern and legacy snapshots', async () => {
  mocks.snapshots
    .mockResolvedValueOnce([
      {
        provider: 'spotify',
        payload: { ...spotifyRelease, id: otherSpotifyId },
      },
      {
        provider: 'spotify',
        payload: {
          source: 'saved-album',
          data: spotifyRelease,
          extra: 'fixture',
        },
      },
    ])
    .mockResolvedValueOnce([
      {
        provider: 'legacy-record',
        payload: { mb: { releaseGroup: musicBrainzRelease } },
      },
    ])

  expect(await getAlbumReleaseHints('fixture-album')).toEqual([
    {
      source: 'spotify',
      title: 'Fixture edition',
      year: 2003,
      releaseDate: '2003-03',
      releaseType: 'compilation',
      artists: ['Fixture artist'],
    },
    {
      source: 'musicbrainz',
      title: 'Fixture release group',
      year: 1999,
      releaseDate: '1999',
      releaseType: 'album',
      artists: ['Fixture credited artist'],
    },
  ])
})

it('uses the latest override and omits unverifiable optional fields', async () => {
  mocks.overrides.mockResolvedValue([
    { provider: 'spotify', referenceType: 'spotify', externalId: spotifyId },
    { provider: 'spotify', referenceType: 'album', externalId: otherSpotifyId },
  ])
  mocks.snapshots.mockResolvedValueOnce([
    { provider: 'spotify', payload: { ...spotifyRelease, id: otherSpotifyId } },
    {
      provider: 'legacy-record',
      payload: {
        spotify: {
          id: spotifyId,
          name: 'Verified title',
          release_date: '2003-02-31',
          album_type: 'unknown',
          artists: [{ name: 123 }],
        },
      },
    },
  ])

  expect(await getAlbumReleaseHints('fixture-album')).toEqual([
    { source: 'spotify', title: 'Verified title' },
  ])
})

it('omits ambiguous reference identities and rejects mismatched snapshot IDs', async () => {
  mocks.references.mockResolvedValue([
    {
      provider: 'spotify',
      referenceType: 'album',
      externalId: spotifyId,
      isPrimary: true,
    },
    {
      provider: 'spotify',
      referenceType: 'album',
      externalId: otherSpotifyId,
      isPrimary: true,
    },
    {
      provider: 'musicbrainz',
      referenceType: 'release-group',
      externalId: releaseGroupId,
      isPrimary: true,
    },
  ])
  mocks.snapshots.mockResolvedValueOnce([
    {
      provider: 'musicbrainz',
      payload: {
        releaseGroup: {
          ...musicBrainzRelease,
          id: '66666666-7777-4888-8999-000000000000',
        },
      },
    },
  ])

  expect(await getAlbumReleaseHints('fixture-album')).toEqual([])
  expect(mocks.snapshots).toHaveBeenCalledTimes(1)
})

it.each([
  { provider: 'discogs', payload: { master, mainRelease: { id: 789 } } },
  { provider: 'discogs', payload: { discogs: { master } } },
  {
    provider: 'legacy-record',
    payload: { discogs: { master: { ...master, id: String(masterId) } } },
  },
])('reads a linked Discogs master from $provider', async (snapshot) => {
  mocks.references.mockResolvedValue([masterReference])
  mocks.snapshots.mockResolvedValue([snapshot])

  expect(await getAlbumReleaseHints('fixture-album')).toEqual([
    {
      source: 'discogs',
      title: 'Fixture master',
      year: 1995,
      artists: ['Fixture Writer (Fixture Alias)'],
    },
  ])
})

it('uses the corrected Discogs master and omits unverifiable optional fields', async () => {
  mocks.references.mockResolvedValue([masterReference])
  mocks.overrides.mockResolvedValue([
    { ...masterReference, externalId: '67890' },
  ])
  mocks.snapshots.mockResolvedValue([
    { provider: 'discogs', payload: { master } },
    { provider: 'discogs', payload: { release: { ...master, id: 67890 } } },
    {
      provider: 'discogs',
      payload: {
        master: {
          ...master,
          id: 67890,
          year: 0,
          artists: [{ name: false }],
          release_type: 'album',
        },
      },
    },
  ])

  expect(await getAlbumReleaseHints('fixture-album')).toEqual([
    { source: 'discogs', title: 'Fixture master' },
  ])
})

it.each([
  { referenceType: 'release', externalId: String(masterId) },
  { referenceType: 'master', externalId: '0123456' },
  { referenceType: 'master', externalId: '9007199254740992' },
])(
  'does not read a Discogs master for correction $referenceType $externalId',
  async (override) => {
    mocks.references.mockResolvedValue([masterReference])
    mocks.overrides.mockResolvedValue([{ provider: 'discogs', ...override }])

    expect(await getAlbumReleaseHints('fixture-album')).toEqual([])
    expect(mocks.snapshots).not.toHaveBeenCalled()
  },
)

const trackNames = [
  'Fixture Opening',
  'Fixture Interlude',
  'Fixture Finale',
  'Fixture Encore',
  'Fixture Reprise',
]
const spotifyTracks = {
  offset: 0,
  next: null,
  total: trackNames.length,
  items: trackNames.map((name, index) => ({
    name,
    disc_number: 1,
    track_number: index + 1,
    artists:
      index < 2
        ? [{ name: 'Fixture Guest' }, { name: 'Fixture Guest' }]
        : [{ name: 'Fixture Artist' }],
  })),
}

it.each([true, false])(
  'includes complete track titles and timings only when requested (%s)',
  async (includeTrackDetails) => {
    mocks.tracks.mockResolvedValue(trackNames.map((title) => ({ title })))
    const items = spotifyTracks.items.map((track, i) => ({
      ...track,
      duration_ms: (i + 1) * 1000,
    }))
    mocks.snapshots.mockResolvedValueOnce([
      {
        provider: 'spotify',
        payload: { ...spotifyRelease, tracks: { ...spotifyTracks, items } },
      },
    ])
    const evidence = (
      await getAlbumReleaseHints('fixture-album', [], includeTrackDetails)
    )[0]?.trackEvidence
    expect(evidence?.exactSequence).toBe(true)
    expect(evidence?.tracks).toEqual(
      includeTrackDetails
        ? trackNames.map((title, i) => ({ title, durationSec: i + 1 }))
        : undefined,
    )
  },
)

it('compares a complete Spotify sequence and reports each artist once per track', async () => {
  mocks.tracks.mockResolvedValue(trackNames.map((title) => ({ title })))
  mocks.snapshots.mockResolvedValueOnce([
    {
      provider: 'spotify',
      payload: {
        data: {
          ...spotifyRelease,
          release_date: '2003-03-10',
          release_date_precision: 'day',
          total_tracks: 5,
          tracks: {
            ...spotifyTracks,
            items: [...spotifyTracks.items].reverse(),
          },
        },
      },
    },
  ])
  expect(await getAlbumReleaseHints('fixture-album')).toMatchObject([
    {
      source: 'spotify',
      releaseDate: '2003-03-10',
      trackEvidence: {
        libraryTracks: 5,
        matchedTracks: 5,
        exactSequence: true,
        creditedArtists: [
          { name: 'Fixture Artist', tracks: 3 },
          { name: 'Fixture Guest', tracks: 2 },
        ],
      },
    },
  ])
})

it.each([
  { ...spotifyTracks, next: 'https://example.test/tracks?page=2' },
  { ...spotifyTracks, offset: 5 },
  { ...spotifyTracks, total: 6 },
  { ...spotifyTracks, items: [{ name: ' ' }, ...spotifyTracks.items.slice(1)] },
  {
    ...spotifyTracks,
    items: [spotifyTracks.items[1], ...spotifyTracks.items.slice(1)],
  },
])(
  'omits evidence for an incomplete or invalid Spotify tracklist',
  async (tracks) => {
    mocks.tracks.mockResolvedValue(trackNames.map((title) => ({ title })))
    mocks.snapshots.mockResolvedValueOnce([
      { provider: 'spotify', payload: { ...spotifyRelease, tracks } },
    ])
    expect(
      (await getAlbumReleaseHints('fixture-album'))[0]?.trackEvidence,
    ).toBeUndefined()
  },
)

it.each([
  {
    titles: trackNames,
    items: [
      { ...spotifyTracks.items[0], artists: [{ name: ' ' }] },
      ...spotifyTracks.items.slice(1),
    ],
    exactSequence: true,
    matchedTracks: 5,
  },
  {
    titles: Array.from({ length: 5 }, () => 'Fixture Interlude'),
    items: spotifyTracks.items.map((track) => ({
      ...track,
      name: 'Fixture Interlude',
    })),
    exactSequence: true,
    matchedTracks: 1,
  },
  {
    titles: [...trackNames].reverse(),
    items: spotifyTracks.items,
    exactSequence: false,
    matchedTracks: 5,
  },
])(
  'omits Spotify artist counts without distinctive, valid exact credits',
  async ({ titles, items, exactSequence, matchedTracks }) => {
    mocks.tracks.mockResolvedValue(titles.map((title) => ({ title })))
    mocks.snapshots.mockResolvedValueOnce([
      {
        provider: 'legacy-record',
        payload: {
          spotify: { ...spotifyRelease, tracks: { ...spotifyTracks, items } },
        },
      },
    ])
    expect(
      (await getAlbumReleaseHints('fixture-album'))[0]?.trackEvidence,
    ).toEqual({ libraryTracks: 5, exactSequence, matchedTracks })
  },
)

it.each([
  { format: 'LP, Album', expected: 'album' },
  { format: '7", Single', expected: undefined },
  { format: 'Cassette, Promo', expected: 'album' },
])(
  'requires agreement among Discogs release formats with the master title',
  async ({ format, expected }) => {
    mocks.references.mockResolvedValue([masterReference])
    mocks.tracks.mockResolvedValue(trackNames.map((title) => ({ title })))
    mocks.snapshots.mockResolvedValueOnce([
      {
        provider: 'legacy-record',
        payload: {
          discogs: {
            master: {
              ...master,
              main_release: 100,
              tracklist: [
                { title: 'Side A', type_: 'heading' },
                ...trackNames
                  .slice(0, 4)
                  .map((title) => ({ title, type_: 'track' })),
              ],
            },
            releases: [
              {
                id: 100,
                title: master.title,
                major_formats: ['Vinyl'],
                format: 'LP, Album, Limited Edition',
              },
              {
                id: 200,
                title: master.title,
                major_formats: ['Vinyl'],
                format,
              },
              {
                id: 300,
                title: 'Unrelated title',
                major_formats: ['Vinyl'],
                format: '7", EP',
              },
            ],
          },
        },
      },
    ])
    const hint = (await getAlbumReleaseHints('fixture-album'))[0]
    expect(hint?.releaseType).toBe(expected)
    expect(hint?.trackEvidence).toEqual({
      libraryTracks: 5,
      matchedTracks: 4,
      exactSequence: false,
    })
  },
)

it('omits Spotify track evidence past the track limit and omits a date with conflicting precision', async () => {
  mocks.tracks.mockResolvedValue(
    Array.from({ length: 501 }, (_, index) => ({
      title: `Fixture track ${index}`,
    })),
  )
  mocks.snapshots.mockResolvedValueOnce([
    {
      provider: 'spotify',
      payload: {
        ...spotifyRelease,
        release_date: '2003-03-10',
        release_date_precision: 'month',
        tracks: spotifyTracks,
      },
    },
  ])
  const hint = (await getAlbumReleaseHints('fixture-album'))[0]
  expect(hint).toMatchObject({ year: 2003 })
  expect(hint?.releaseDate).toBeUndefined()
  expect(hint?.trackEvidence).toBeUndefined()
})

it.each([
  { id: 100, master_id: masterId, expected: 'ep' },
  { id: 123, master_id: masterId, expected: undefined },
  { id: 100, master_id: 123, expected: undefined },
])(
  'reads formats only from the verified Discogs main release',
  async ({ id, master_id, expected }) => {
    mocks.references.mockResolvedValue([masterReference])
    mocks.snapshots.mockResolvedValueOnce([
      {
        provider: 'discogs',
        payload: {
          master: { ...master, main_release: 100 },
          mainRelease: {
            id,
            master_id,
            title: master.title,
            formats: [{ descriptions: ['EP'] }],
          },
          versions: {
            pagination: { page: 1, pages: 2, items: 2 },
            versions: [{ id: 200, title: master.title, format: 'LP, Album' }],
          },
        },
      },
    ])
    expect((await getAlbumReleaseHints('fixture-album'))[0]?.releaseType).toBe(
      expected,
    )
  },
)
