import {
  DeviceRowSchema,
  devicePayloadSchemas,
  type DeviceAlbumRow,
  type DeviceArtistRow,
  type DeviceEntity,
  type DeviceFilmRow,
  type DevicePlaylistRow,
  type DeviceRow,
  type DeviceTrackRow,
} from '@repo/schemas/device'
import { openBetterSqliteDriver } from '../src/drivers/better-sqlite3'
import { openWasmMemoryDriver } from '../src/drivers/sqlite-wasm'
import type { SqliteDriver } from '../src/driver'

/** Synthetic rows only: every name and ID below is invented. */

export const drivers: { name: string; open: () => Promise<SqliteDriver> }[] = [
  {
    name: 'better-sqlite3',
    open: () => Promise.resolve(openBetterSqliteDriver()),
  },
  { name: 'sqlite-wasm', open: () => openWasmMemoryDriver() },
]

const DAY_US = 86_400_000_000
const BASE_US = 1_700_000_000_000_000

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

export type TrackOptions = {
  title?: string
  artist?: string
  album?: string | null
  dateAddedDay?: number
  durationSec?: number
  scrobbles?: number
  tagIds?: string[]
  nameIds?: string[]
  archived?: boolean
}

export function trackPayload(
  id: string,
  options: TrackOptions = {},
): DeviceTrackRow {
  const title = options.title ?? `Track ${id}`
  const artist = options.artist ?? 'Example Artist'
  const album = options.album === undefined ? 'Example Album' : options.album
  const dateAdded = BASE_US + (options.dateAddedDay ?? 0) * DAY_US
  const durationSec = options.durationSec ?? 241
  const scrobbles = options.scrobbles ?? 3
  const payload = {
    item: {
      id,
      mediaType: 'track',
      title,
      artworkUrl: null,
      releaseDate: '2001-02-03T00:00:00.000Z',
      artists: [artist],
      artistCredits: [{ id: `artist-${artist}`, name: artist }],
      albumName: album,
      album:
        album === null
          ? null
          : { id: 'album-1', title: album, inLibrary: true },
      albumLinkStrategy: album === null ? null : 'album-track-list',
      trackTags: [],
      albumTags: ['Ambient'],
      artistTags: ['Drone'],
      playlists: [{ id: 'playlist-1', name: 'Example Playlist' }],
      sources: ['album'],
      durationSec,
      bpm: null,
      musicalKey: '8A',
      dateAdded: new Date(dateAdded / 1000).toISOString(),
      spotifyTrackId: null,
      spotifyAlbumId: null,
      spotifyMatch: 'unmatched',
      providers: [],
      spotifyUrl: null,
      isrc: null,
      scrobbles,
      lastListenedAt: '2024-06-01T10:00:00.000Z',
    },
    text: {
      title: [title],
      source: ['Album track list'],
      spotifyMatch: ['Unmatched'],
      provider: [],
      artist: [artist],
      album: album === null ? [] : [album],
      playlist: ['Example Playlist'],
      albumLink: [album === null ? 'Not in library' : 'In library'],
      hasTrackTags: ['No'],
      musicalKey: ['8A'],
    },
    search: { trackTag: [], albumTag: ['Ambient'], artistTag: ['Drone'] },
    num: {
      releaseDate: 981_158_400_000_000,
      dateAdded,
      durationSec,
      bpm: null,
      scrobbles,
      lastListenedAt: 1_717_236_000_000_000,
    },
    sort: {
      title: title.toLowerCase(),
      artist: artist.toLowerCase(),
      album: album === null ? null : album.toLowerCase(),
      releaseDate: 981_158_400_000_000,
      genre: tagSort,
      artistTag: 'drone',
      trackTag: null,
      albumTag: 'ambient',
      playlist: 'example playlist',
      source: 'album track list',
      provider: null,
      spotifyMatch: 'unmatched',
      albumLink: album === null ? 'not in library' : 'in library',
      hasTrackTags: 'no',
      musicalKey: 16,
      natural: {
        artist: artist.toLowerCase(),
        albumDate: 981_158_400_000_000,
        year: 2001,
        spotifyAlbumId: null,
        position: 4,
      },
    },
    extra: {
      archived: options.archived ?? false,
      redundantPlaceholder: false,
      albumId: album === null ? null : 'album-1',
      artistIds: [`artist-${artist}`],
      hasOwnTags: false,
      ownTagIds: [],
      ownSonovaultTagIds: [],
      albumTagIds: options.tagIds ?? ['tag-1'],
      albumReleaseTagCount: 1,
      artistTagKeys: ['drone'],
      artistTagLabelKeys: ['drone'],
      recording: {
        key: null,
        shown: false,
        playable: false,
        linked: album !== null,
        releaseDate: 981_158_400_000_000,
      },
      scrobbleNameIds: options.nameIds ?? [`name-${id}`],
    },
  }
  return devicePayloadSchemas.track.parse(payload)
}

type TrackSort = DeviceTrackRow['sort']
type TrackExtra = DeviceTrackRow['extra']

/** Changes to the default track row, section by section. */
export type TrackRowPatch = {
  item?: Partial<DeviceTrackRow['item']>
  text?: Partial<DeviceTrackRow['text']>
  search?: Partial<DeviceTrackRow['search']>
  num?: Partial<DeviceTrackRow['num']>
  sort?: Partial<Omit<TrackSort, 'natural' | 'genre'>> & {
    natural?: Partial<TrackSort['natural']>
    genre?: Partial<TrackSort['genre']>
  }
  extra?: Partial<Omit<TrackExtra, 'recording'>> & {
    recording?: Partial<TrackExtra['recording']>
  }
}

/** The track row of `trackPayload` with the patch applied, validated. */
export function trackRow(
  id: string,
  patch: TrackRowPatch = {},
  options: TrackOptions = {},
): DeviceTrackRow {
  const base = trackPayload(id, options)
  const { natural, genre, ...sort } = patch.sort ?? {}
  const { recording, ...extra } = patch.extra ?? {}
  return devicePayloadSchemas.track.parse({
    item: { ...base.item, ...patch.item },
    text: { ...base.text, ...patch.text },
    search: { ...base.search, ...patch.search },
    num: { ...base.num, ...patch.num },
    sort: {
      ...base.sort,
      ...sort,
      natural: { ...base.sort.natural, ...natural },
      genre: { ...base.sort.genre, ...genre },
    },
    extra: {
      ...base.extra,
      ...extra,
      recording: { ...base.extra.recording, ...recording },
    },
  })
}

export type TagOptions = {
  name: string
  key?: string
  hidden?: boolean
  aliasTargetId?: string | null
  identityKeys?: string[]
}

/** An album-library tag; the key defaults to the lower-cased name. */
export function tagPayload(options: TagOptions) {
  return devicePayloadSchemas.tag.parse({
    mediaType: 'album',
    name: options.name,
    key: options.key ?? options.name.toLowerCase(),
    kind: 'genre',
    hidden: options.hidden ?? false,
    aliasTargetId: options.aliasTargetId ?? null,
    identityKeys: options.identityKeys ?? [],
  })
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

export function albumPayload(
  id: string,
  options: { title?: string; dateAddedDay?: number; mood?: string } = {},
): DeviceAlbumRow {
  const title = options.title ?? `Album ${id}`
  const dateAdded = BASE_US + (options.dateAddedDay ?? 0) * DAY_US
  return devicePayloadSchemas.album.parse({
    item: {
      ...mediaBase,
      id,
      mediaType: 'album',
      title,
      artistTags: ['Drone'],
      dateAdded: new Date(dateAdded / 1000).toISOString(),
      durationSec: 2400,
      spotifyUrl: null,
      trackCount: 10,
    },
    text: {
      title: [title],
      artist: ['Example Artist'],
      country: [],
      playlist: [],
      collection: [],
      source: [],
      provider: [],
      edition: ['Not an edition'],
      pluginMood: [options.mood ?? 'Calm'],
    },
    search: { albumTag: ['Ambient'], artistTag: ['Drone'] },
    num: {
      releaseDate: 981_158_400_000_000,
      dateAdded,
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
      pluginScore: 7,
    },
    sort: {
      title: title.toLowerCase(),
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
      pluginMood: (options.mood ?? 'Calm').toLowerCase(),
    },
    extra: {
      archived: false,
      isEdition: false,
      artistIds: ['artist-1'],
      tagIds: ['tag-1'],
      releaseTagCount: 1,
      artistTagKeys: ['drone'],
      artistTagLabelKeys: ['drone'],
      trackTagIds: ['tag-3'],
    },
  })
}

export function filmPayload(id: string): DeviceFilmRow {
  return devicePayloadSchemas.film.parse({
    item: {
      ...mediaBase,
      id,
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
    num: {
      releaseDate: 981_158_400_000_000,
      dateAdded: 1_714_979_289_000_000,
      updatedAt: 1_714_979_289_000_000,
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
    },
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
      creditIds: { director: ['person-1'], actor: ['person-2', 'person-3'] },
    },
  })
}

export function artistPayload(
  id: string,
  options: { name?: string } = {},
): DeviceArtistRow {
  const name = options.name ?? `Artist ${id}`
  return devicePayloadSchemas.artist.parse({
    item: {
      inLibrary: true,
      id,
      name,
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
      name: [name],
      playlist: ['Example Playlist'],
      genre: ['Drone'],
      country: [],
      type: [],
      provider: ['lastfm'],
    },
    search: { name: [name, `${name}, The`] },
    num: {
      createdAt: 1_714_979_289_000_000,
      albumCount: 1,
      trackCount: 10,
      scrobbles: 12,
      playlistCount: 1,
    },
    sort: {
      name: name.toLowerCase(),
      playlist: 'example playlist',
      genre: 'drone',
      country: null,
      type: null,
      provider: 'lastfm',
    },
    extra: { rawTagKeys: ['drone'], playlistIds: ['playlist-1'] },
  })
}

export function playlistPayload(id: string): DevicePlaylistRow {
  return devicePayloadSchemas.playlist.parse({
    item: {
      inLibrary: true,
      createdAt: '2024-05-06T07:08:09.000Z',
      id,
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
      imported: 1_714_979_289_000_000,
      checked: 1_714_979_289_000_000,
      added: 1_714_979_289_000_000,
    },
    sort: {
      name: 'example playlist',
      source: 3,
      owner: 'example owner',
      description: null,
      schedule: 1,
      nextSync: 1_715_065_689_000_000,
    },
    extra: { source: 'spotify', syncGroupKey: 'spotify:example' },
  })
}

export const sharedPayloads = {
  playlist_job: {
    jobId: 'job-1',
    status: 'succeeded',
    errorMessage: null,
    finishedAt: '2024-05-06T07:08:09.000Z',
  },
  tag: {
    mediaType: 'album',
    name: 'Ambient',
    key: 'ambient',
    kind: 'genre',
    hidden: false,
    aliasTargetId: null,
    identityKeys: ['ambient music', 'ambience'],
  },
  tag_key: {
    mediaType: 'album',
    key: 'dark ambient',
    ancestorKeys: ['ambient', 'electronic'],
  },
  scrobble_name: { plays: [1_717_236_000, 1_717_236_000, 1_717_322_400] },
  album_plays: { plays: [1_717_236_000] },
  artist_plays: { plays: [1_717_236_000, 1_717_322_400] },
  meta: { kind: 'listening', historyStart: '2010-01-01' },
}

/** A live feed row, validated with the shared schema. */
export function live(
  entity: DeviceEntity,
  id: string,
  seq: number,
  payload: unknown,
): DeviceRow {
  return DeviceRowSchema.parse({ entity, id, seq, deleted: false, payload })
}

export function tombstone(
  entity: DeviceEntity,
  id: string,
  seq: number,
): DeviceRow {
  return DeviceRowSchema.parse({
    entity,
    id,
    seq,
    deleted: true,
    payload: null,
  })
}
