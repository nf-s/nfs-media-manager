import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
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
      releaseType: 'compilation',
      artists: ['Fixture artist'],
    },
    {
      source: 'musicbrainz',
      title: 'Fixture release group',
      year: 1999,
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
