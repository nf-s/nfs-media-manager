import { describe, expect, it } from 'vitest'
import {
  DEVICE_ROW_VERSION,
  DeviceChangesQuerySchema,
  DeviceChangesResponseSchema,
  DeviceFeedStateSchema,
  DeviceRowSchema,
  DeviceSnapshotQuerySchema,
  DeviceSnapshotResponseSchema,
  devicePayloadSchemas,
} from '../src/device'

const tagSort = {
  auto: 'ambient',
  track: null,
  album: 'ambient',
  artist: 'drone',
  'track,album': 'ambient',
  'track,artist': 'drone',
  'album,artist': 'ambient',
  'track,album,artist': 'ambient',
}

const track = {
  item: {
    id: 'track-1',
    mediaType: 'track',
    title: 'Example Track',
    artworkUrl: null,
    releaseDate: '2001-02-03T00:00:00.000Z',
    artists: ['Example Artist'],
    artistCredits: [{ id: 'artist-1', name: 'Example Artist' }],
    albumName: 'Example Album',
    album: { id: 'album-1', title: 'Example Album', inLibrary: true },
    albumLinkStrategy: 'album-track-list',
    trackTags: [],
    albumTags: ['Ambient'],
    artistTags: ['Drone'],
    playlists: [{ id: 'playlist-1', name: 'Example Playlist' }],
    sources: ['album'],
    durationSec: 241,
    bpm: null,
    musicalKey: '8A',
    dateAdded: '2024-05-06T07:08:09.000Z',
    spotifyTrackId: null,
    spotifyAlbumId: null,
    spotifyMatch: 'unmatched',
    providers: [],
    spotifyUrl: null,
    isrc: null,
    scrobbles: 3,
    lastListenedAt: '2024-06-01T10:00:00.000Z',
  },
  text: {
    title: ['Example Track'],
    source: ['Album track list'],
    spotifyMatch: ['Unmatched'],
    provider: [],
    artist: ['Example Artist'],
    album: ['Example Album'],
    playlist: ['Example Playlist'],
    albumLink: ['In library'],
    hasTrackTags: ['No'],
    musicalKey: ['8A'],
  },
  search: { trackTag: [], albumTag: ['Ambient'], artistTag: ['Drone'] },
  num: {
    releaseDate: 981158400000,
    dateAdded: 1714979289000,
    durationSec: 241,
    bpm: null,
    scrobbles: 3,
    lastListenedAt: 1717236000000,
  },
  sort: {
    title: 'example track',
    artist: 'example artist',
    album: 'example album',
    releaseDate: 981158400000,
    genre: tagSort,
    artistTag: 'drone',
    trackTag: null,
    albumTag: 'ambient',
    playlist: 'example playlist',
    source: 'album track list',
    provider: null,
    spotifyMatch: 'unmatched',
    albumLink: 'in library',
    hasTrackTags: 'no',
    musicalKey: 16,
    natural: {
      artist: 'example artist',
      albumDate: 981158400000,
      year: 2001,
      spotifyAlbumId: null,
      position: 4,
    },
  },
  extra: {
    archived: false,
    redundantPlaceholder: false,
    albumId: 'album-1',
    artistIds: ['artist-1'],
    hasOwnTags: false,
    ownTagIds: [],
    ownSonovaultTagIds: [],
    albumTagIds: ['tag-1'],
    albumReleaseTagCount: 1,
    artistTagKeys: ['drone'],
    artistTagLabelKeys: ['drone'],
    recording: {
      key: null,
      shown: false,
      playable: false,
      linked: true,
      releaseDate: 981158400000,
    },
    scrobbleNameIds: ['name-1'],
  },
}

const mediaBase = {
  slug: 'example',
  originalTitle: null,
  summary: null,
  artworkUrl: null,
  releaseDate: '2001-02-03T00:00:00.000Z',
  sourceLabel: null,
  metadata: null,
  tags: [{ id: 'tag-1', name: 'Ambient', kind: 'genre' }],
  credits: [
    { id: 'artist-1', name: 'Example Artist', role: 'artist', billingOrder: 0 },
  ],
  links: [],
  providerReferences: [],
  playlists: [],
  createdAt: '2024-05-06T07:08:09.000Z',
  updatedAt: '2024-05-06T07:08:09.000Z',
}

const album = {
  item: {
    ...mediaBase,
    id: 'album-1',
    mediaType: 'album',
    title: 'Example Album',
    artistTags: ['Drone'],
    dateAdded: '2024-05-06T07:08:09.000Z',
    durationSec: 2400,
    spotifyUrl: null,
    trackCount: 10,
  },
  text: {
    title: ['Example Album'],
    artist: ['Example Artist'],
    country: [],
    playlist: [],
    collection: [],
    source: [],
    provider: [],
    edition: ['Not an edition'],
    pluginMood: ['Calm'],
  },
  search: { albumTag: ['Ambient'], artistTag: ['Drone'] },
  num: {
    releaseDate: 981158400000,
    dateAdded: 1714979289000,
    durationSec: 2400,
    trackCount: 10,
    scrobbles: 12,
    lastListenedAt: null,
    scrobblesLast1y: 2,
    scrobblesLast5y: 12,
    ratingRymValue: 3.5,
    ratingRymVotes: 40,
    ratingDiscogsValue: null,
    ratingDiscogsVotes: null,
    ratingMetacriticValue: null,
    ratingMetacriticVotes: null,
    popularityDiscogs: null,
    popularitySpotify: null,
    popularityLastFm: null,
    pluginMood: null,
  },
  sort: {
    title: 'example album',
    artist: 'example artist',
    country: null,
    playlist: null,
    collection: null,
    source: null,
    provider: null,
    edition: 'not an edition',
    albumTag: 'ambient',
    artistTag: 'drone',
    genre: tagSort,
    pluginMood: 'calm',
  },
  extra: {
    archived: false,
    isEdition: false,
    artistIds: ['artist-1'],
    tagIds: ['tag-1'],
    releaseTagCount: 1,
    artistTagKeys: ['drone'],
    artistTagLabelKeys: ['drone'],
    trackTagIds: [],
  },
}

const filmNumbers = {
  releaseDate: 981158400000,
  dateAdded: 1714979289000,
  updatedAt: 1714979289000,
  runtimeMinutes: 95,
  budget: null,
  boxOffice: null,
  ratingImdbPersonal: null,
  ratingImdbPersonalDate: null,
  ratingImdbValue: 7.1,
  ratingImdbVotes: 1000,
  ratingMetascore: null,
  ratingTmdbValue: null,
  ratingTmdbVotes: null,
  popularityTmdb: null,
  ratingRt: null,
  ratingMetacriticUser: null,
  ratingMetacriticUserVotes: null,
  ratingTrakt: null,
  ratingTraktVotes: null,
  ratingLetterboxd: null,
  ratingLetterboxdVotes: null,
  ratingRtAudience: null,
  ratingRtAudienceVotes: null,
}

const film = {
  item: {
    ...mediaBase,
    id: 'film-1',
    mediaType: 'film',
    title: 'Example Film',
    tags: [{ id: 'tag-2', name: 'Drama', kind: 'genre' }],
    credits: [
      {
        id: 'person-1',
        name: 'Example Person',
        role: 'director',
        billingOrder: 0,
      },
    ],
    runtimeMinutes: 95,
    watched: true,
    sourceKind: 'file',
    budget: null,
    boxOffice: null,
  },
  text: {
    summary: [],
    title: ['Example Film'],
    director: ['Example Person'],
    actor: [],
    writer: [],
    country: [],
    language: [],
    productionCompany: [],
    awards: [],
    collection: [],
    playlist: [],
    source: ['file'],
    watched: ['Yes'],
    identification: ['Needs ID'],
    provider: [],
  },
  search: { genre: ['Drama'] },
  num: filmNumbers,
  sort: {
    summary: null,
    title: 'example film',
    director: 'example person',
    actor: null,
    writer: null,
    country: null,
    language: null,
    productionCompany: null,
    awards: null,
    source: 'file',
    watched: 'yes',
    identification: 'needs id',
    provider: null,
    genre: 'drama',
    collection: null,
    playlist: null,
  },
  extra: {
    archived: false,
    sourceKind: 'file',
    tagIds: ['tag-2'],
    creditIds: { director: ['person-1'], actor: [] },
  },
}

const artist = {
  item: {
    inLibrary: true,
    id: 'artist-1',
    name: 'Example Artist',
    sortName: null,
    createdAt: '2024-05-06T07:08:09.000Z',
    artworkUrl: null,
    albumCount: 1,
    trackCount: 10,
    playlistCount: 1,
    scrobbleCount: 12,
    browse: { genre: ['Drone'], playlist: ['Example Playlist'] },
  },
  text: {
    name: ['Example Artist'],
    playlist: ['Example Playlist'],
    genre: ['Drone'],
    country: [],
    type: [],
    provider: ['lastfm'],
  },
  search: { name: ['Example Artist'] },
  num: {
    createdAt: 1714979289000,
    albumCount: 1,
    trackCount: 10,
    scrobbles: 12,
    playlistCount: 1,
  },
  sort: {
    name: 'example artist',
    playlist: 'example playlist',
    genre: 'drone',
    country: null,
    type: null,
    provider: 'lastfm',
  },
  extra: { rawTagKeys: ['drone'], playlistIds: ['playlist-1'] },
}

const playlist = {
  item: {
    inLibrary: true,
    createdAt: '2024-05-06T07:08:09.000Z',
    id: 'playlist-1',
    name: 'Example Playlist',
    source: 'spotify',
    ownerName: 'Example Owner',
    description: null,
    artworkUrl: null,
    spotifyUrl: null,
    importedAt: '2024-05-06T07:08:09.000Z',
    trackCount: 20,
    linkedTrackCount: 18,
    albumCount: 2,
    presentation: 'tracks',
    presentationOverride: null,
    durationSec: 4800,
    acceptsAdditions: false,
    sync: {
      syncable: true,
      schedule: 'daily',
      lastCheckedAt: '2024-05-06T07:08:09.000Z',
      nextScheduledAt: '2024-05-07T07:08:09.000Z',
    },
  },
  text: {},
  search: {
    name: ['Example Playlist'],
    owner: ['Example Owner'],
    description: [],
  },
  num: {
    tracks: 20,
    linkedTracks: 18,
    albums: 2,
    duration: 4800,
    imported: 1714979289000,
    checked: 1714979289000,
    added: 1714979289000,
  },
  sort: {
    name: 'example playlist',
    source: 3,
    owner: 'example owner',
    description: null,
    schedule: 1,
    nextSync: 1715065689000,
  },
  extra: { source: 'spotify', syncGroupKey: 'spotify:example' },
}

const playlistJob = {
  jobId: 'job-1',
  status: 'succeeded',
  errorMessage: null,
  finishedAt: '2024-05-06T07:08:09.000Z',
}

const payloads = {
  track,
  album,
  film,
  artist,
  playlist,
  playlist_job: playlistJob,
  tag: {
    mediaType: 'album',
    name: 'Ambient',
    key: 'ambient',
    kind: 'genre',
    hidden: false,
    aliasTargetId: null,
    identityKeys: ['ambient music'],
  },
  tag_key: {
    mediaType: 'album',
    key: 'dark ambient',
    ancestorKeys: ['ambient'],
  },
  scrobble_name: { plays: [1717236000, 1717322400] },
  album_plays: { plays: [1717236000] },
  artist_plays: { plays: [1717236000, 1717322400] },
  meta: { kind: 'listening', historyStart: '2010-01-01' },
}

describe('device rows', () => {
  it('parses one synthetic row of every entity', () => {
    for (const [entity, payload] of Object.entries(payloads)) {
      const row = DeviceRowSchema.parse({
        entity,
        id: `${entity}-1`,
        seq: 1,
        deleted: false,
        payload,
      })
      expect(row.entity).toBe(entity)
    }
    expect(Object.keys(payloads).sort()).toEqual(
      Object.keys(devicePayloadSchemas).sort(),
    )
  })

  it('keeps plugin fields of albums and rejects unknown projection keys', () => {
    const parsed = devicePayloadSchemas.album.parse(album)
    expect(parsed.text.pluginMood).toEqual(['Calm'])
    expect(parsed.sort.pluginMood).toBe('calm')
    expect(
      devicePayloadSchemas.track.safeParse({
        ...track,
        extra: { ...track.extra, unknown: true },
      }).success,
    ).toBe(false)
    expect(
      devicePayloadSchemas.playlist.safeParse({
        ...playlist,
        item: {
          ...playlist.item,
          sync: { ...playlist.item.sync, job: playlistJob },
        },
      }).data?.item.sync,
    ).not.toHaveProperty('job')
  })

  it('reads every Tags sort location', () => {
    const { genre } = devicePayloadSchemas.track.parse(track).sort
    expect(Object.keys(genre)).toHaveLength(8)
    expect(
      devicePayloadSchemas.track.safeParse({
        ...track,
        sort: { ...track.sort, genre: { auto: null } },
      }).success,
    ).toBe(false)
  })
})

describe('device feed', () => {
  it('parses state, queries and a changes page with a tombstone', () => {
    expect(
      DeviceFeedStateSchema.parse({
        ready: true,
        epoch: 'epoch-1',
        seq: 9,
        minSeq: 2,
        rowVersion: DEVICE_ROW_VERSION,
      }).seq,
    ).toBe(9)
    expect(
      DeviceSnapshotQuerySchema.parse({ epoch: 'epoch-1', entity: 'track' }),
    ).toEqual({ epoch: 'epoch-1', entity: 'track', after: 0, limit: 500 })
    expect(
      DeviceChangesQuerySchema.safeParse({
        epoch: 'epoch-1',
        since: '3',
        limit: '5000',
      }).success,
    ).toBe(false)
    const page = DeviceChangesResponseSchema.parse({
      reset: false,
      rows: [
        {
          entity: 'tag',
          id: 'tag-1',
          seq: 8,
          deleted: false,
          payload: payloads.tag,
        },
        {
          entity: 'track',
          id: 'track-2',
          seq: 9,
          deleted: true,
          payload: null,
        },
      ],
      seq: 9,
      hasMore: false,
      pending: false,
    })
    expect(page.reset ? [] : page.rows.map((row) => row.deleted)).toEqual([
      false,
      true,
    ])
    expect(DeviceChangesResponseSchema.parse({ reset: true })).toEqual({
      reset: true,
    })
  })

  it('keeps tombstones out of snapshots', () => {
    expect(
      DeviceSnapshotResponseSchema.safeParse({
        reset: false,
        rows: [
          {
            entity: 'track',
            id: 'track-2',
            seq: 9,
            deleted: true,
            payload: null,
          },
        ],
        seq: 9,
        hasMore: false,
      }).success,
    ).toBe(false)
  })
})
