import { z } from 'zod'
import type { JsonValue } from '@repo/media-plugin-sdk'
import {
  LegacyRymAlbumUrlSchema,
  LastFmUrlSchema,
} from '@repo/schemas/provider-identification'
import { AlbumMbidSchema } from '@/plugins/builtin/album-provider-helpers'
import { readSerplyPageResults } from '@/plugins/builtin/serply'
import { SpotifyAlbumSchema, SpotifyIdSchema } from './spotify-api'

const Provider = z.enum([
  'musicbrainz',
  'discogs',
  'lastfm',
  'serply',
  'spotify',
])
export const musicObservationProviders = Provider.options
type Provider = z.infer<typeof Provider>
const Name = z
  .string()
  .transform((value) => value.replaceAll('\u0000', '').trim().slice(0, 500))
  .pipe(z.string().min(1))
const NumberId = z
  .union([
    z.number().int().positive().safe(),
    z.string().regex(/^[1-9]\d{0,14}$/),
  ])
  .transform(String)
const ObjectSchema = z.record(z.string(), z.unknown())
const IsoDate = z
  .union([z.string(), z.number()])
  .transform(String)
  .pipe(z.string().regex(/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/))
const ArtistName = z.object({ name: Name })
const DiscogsArtist = ArtistName.extend({
  id: NumberId.optional().catch(undefined),
  role: Name.optional().catch(undefined),
})
const MbArtist = ArtistName.extend({ id: AlbumMbidSchema })
const SpotifyArtist = ArtistName.extend({ id: SpotifyIdSchema })
const LastFmArtist = ArtistName.extend({
  mbid: AlbumMbidSchema.optional().catch(undefined),
  url: z.string().optional().catch(undefined),
})
const MbCredit = z.object({
  name: Name.optional().catch(undefined),
  artist: MbArtist,
})

type Credit = { name: string; externalId?: string; role?: string }
export type MusicDiscovery = {
  kind: 'album' | 'artist' | 'track'
  provider: string
  referenceType: string
  externalId?: string
  provisionalKey?: string
  title: string
  ordinal: number
  relationship: string
  url?: string
  date?: string
  artworkUrl?: string
  durationSec?: number
  trackCount?: number
  credits?: Credit[]
  children?: MusicDiscovery[]
  details?: Record<string, JsonValue>
}

export type MusicResponseSource = {
  provider: string
  method: string
  requestUrl: string | null
  status: number | null
  phase: 'artist' | 'media' | 'task'
}

function relatedAlbum(
  provider: string,
  referenceType: string,
  externalId: string,
  title: string,
  relationship: string,
): MusicDiscovery {
  return {
    kind: 'album',
    provider,
    referenceType,
    externalId,
    title,
    relationship,
    ordinal: 1,
  }
}

function objects<T>(value: unknown, schema: z.ZodType<T>) {
  const list = Array.isArray(value)
    ? value
    : value === null || value === undefined
      ? []
      : [value]
  return list.slice(0, 500).flatMap((entry, index) => {
    const parsed = schema.safeParse(entry)
    return parsed.success ? [{ item: parsed.data, ordinal: index + 1 }] : []
  })
}

function object(value: unknown) {
  return ObjectSchema.safeParse(value).data
}

function webUrl(value: unknown, host?: RegExp) {
  if (typeof value !== 'string' || value.length > 2048) return undefined
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      (host && !host.test(url.hostname))
    )
      return undefined
    url.search = ''
    url.hash = ''
    return url
  } catch {
    return undefined
  }
}

function duration(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const raw = String(value)
  if (/^\d{1,6}$/.test(raw)) return Number(raw)
  if (!/^\d{1,3}:\d\d$/.test(raw)) return undefined
  const [minutes, seconds] = raw.split(':').map(Number)
  return (minutes ?? 0) * 60 + (seconds ?? 0)
}

function albumLink(
  value: unknown,
  ordinal: number,
  relationship: string,
): MusicDiscovery | undefined {
  const url = webUrl(value)
  if (!url) return undefined
  const path = url.pathname
  const spotify =
    url.hostname === 'open.spotify.com'
      ? path.match(/^\/album\/([A-Za-z0-9]{22})\/?$/)
      : null
  const discogs = /^(?:www\.)?discogs\.com$/.test(url.hostname)
    ? path.match(/^\/(master|release)\/(\d+)(?:-[^/]+)?\/?$/)
    : null
  const mb =
    url.hostname === 'musicbrainz.org'
      ? path.match(/^\/(release|release-group)\/([^/]+)\/?$/)
      : null
  if (spotify?.[1])
    return {
      kind: 'album',
      provider: 'spotify',
      referenceType: 'spotify',
      externalId: spotify[1],
      title: 'Spotify release',
      url: url.href,
      ordinal,
      relationship,
    }
  if (discogs?.[1] && discogs[2])
    return {
      kind: 'album',
      provider: 'discogs',
      referenceType: discogs[1],
      externalId: discogs[2],
      title: 'Discogs release',
      url: url.href,
      ordinal,
      relationship,
    }
  if (mb?.[1] && AlbumMbidSchema.safeParse(mb[2]).success)
    return {
      kind: 'album',
      provider: 'musicbrainz',
      referenceType: mb[1],
      externalId: mb[2],
      title: 'MusicBrainz release',
      url: url.href,
      ordinal,
      relationship,
    }
  if (LastFmUrlSchema.safeParse(url.href).success)
    return {
      kind: 'album',
      provider: 'lastfm',
      referenceType: 'url',
      externalId: url.href,
      title: 'Last.fm album',
      url: url.href,
      ordinal,
      relationship,
    }
  if (
    LegacyRymAlbumUrlSchema.safeParse(url.href).success &&
    !/\/(reviews|lists)\/?$/.test(path)
  )
    return {
      kind: 'album',
      provider: 'rym',
      referenceType: 'rym-url',
      externalId: url.href,
      title: 'Rate Your Music release',
      url: url.href,
      ordinal,
      relationship,
    }
}

const MusicBrainzRelease = z.object({
  id: AlbumMbidSchema,
  title: Name,
  'artist-credit': z.unknown().optional(),
  'first-release-date': IsoDate.optional().catch(undefined),
  date: IsoDate.optional().catch(undefined),
  'release-group': z
    .object({ id: AlbumMbidSchema, title: Name.optional().catch(undefined) })
    .optional()
    .catch(undefined),
  relations: z.unknown().optional(),
  media: z.unknown().optional(),
  disambiguation: Name.optional().catch(undefined),
})
const MbRelation = z.object({
  type: Name,
  url: z.object({ resource: z.string() }).optional().catch(undefined),
  artist: MbArtist.optional().catch(undefined),
  release: MusicBrainzRelease.pick({ id: true, title: true })
    .optional()
    .catch(undefined),
  recording: MusicBrainzRelease.pick({ id: true, title: true })
    .optional()
    .catch(undefined),
})
const MbMedium = z.object({ tracks: z.unknown().optional() })
const MbTrack = z.object({
  id: AlbumMbidSchema.optional().catch(undefined),
  title: Name,
  number: z.string().max(30).optional().catch(undefined),
  length: z.number().int().nonnegative().optional().catch(undefined),
  recording: MusicBrainzRelease.pick({
    id: true,
    title: true,
    'artist-credit': true,
  })
    .optional()
    .catch(undefined),
  'artist-credit': z.unknown().optional(),
})
function mbCredits(value: unknown): Credit[] {
  return objects(value, MbCredit).map(({ item }) => ({
    name: item.name ?? item.artist.name,
    externalId: item.artist.id,
  }))
}
function mbRelations(value: unknown): MusicDiscovery[] {
  return objects(value, MbRelation).flatMap(
    ({ item, ordinal }): MusicDiscovery[] => {
      const row = { provider: 'musicbrainz', ordinal, relationship: item.type }
      if (item.artist)
        return [
          {
            ...row,
            kind: 'artist',
            referenceType: 'artist',
            externalId: item.artist.id,
            title: item.artist.name,
          },
        ]
      if (item.release)
        return [
          {
            ...row,
            kind: 'album',
            referenceType: 'release',
            externalId: item.release.id,
            title: item.release.title,
          },
        ]
      if (item.recording)
        return [
          {
            ...row,
            kind: 'track',
            referenceType: 'recording',
            externalId: item.recording.id,
            title: item.recording.title,
          },
        ]
      const linked = albumLink(item.url?.resource, ordinal, item.type)
      return linked ? [linked] : []
    },
  )
}
function mbRelease(
  item: z.infer<typeof MusicBrainzRelease>,
  ordinal: number,
  referenceType: string,
  relationship: string,
): MusicDiscovery {
  const tracks = objects(item.media, MbMedium).flatMap(
    ({ item: medium, ordinal: disc }) =>
      objects(medium.tracks, MbTrack).map(
        ({ item: track, ordinal: position }): MusicDiscovery => ({
          kind: 'track',
          provider: 'musicbrainz',
          referenceType: track.recording ? 'recording' : 'release-track',
          externalId: track.recording?.id ?? track.id,
          title: track.title,
          relationship: 'track_on_edition',
          ordinal: position,
          durationSec:
            track.length === undefined
              ? undefined
              : Math.round(track.length / 1000),
          credits: mbCredits(
            track['artist-credit'] ?? track.recording?.['artist-credit'],
          ),
          details: {
            disc,
            nativePosition: track.number ?? null,
            releaseTrackId: track.id ?? null,
          },
        }),
      ),
  )
  return {
    kind: 'album',
    provider: 'musicbrainz',
    referenceType,
    externalId: item.id,
    title: item.title,
    ordinal,
    relationship,
    date: item.date ?? item['first-release-date'],
    credits: mbCredits(item['artist-credit']),
    trackCount: tracks.length || undefined,
    details: { disambiguation: item.disambiguation ?? null },
    children: [
      ...tracks,
      ...mbRelations(item.relations),
      ...(item['release-group']
        ? [
            relatedAlbum(
              'musicbrainz',
              'release-group',
              item['release-group'].id,
              item['release-group'].title ?? 'MusicBrainz release group',
              'release_group',
            ),
          ]
        : []),
    ],
  }
}

const DiscogsEdition = z.object({
  id: NumberId,
  title: Name,
  artists: z.unknown().optional(),
  extraartists: z.unknown().optional(),
  main_release: NumberId.optional().catch(undefined),
  master_id: NumberId.optional().catch(undefined),
  released: IsoDate.optional().catch(undefined),
  year: IsoDate.optional().catch(undefined),
  tracklist: z.unknown().optional(),
  labels: z.unknown().optional(),
  companies: z.unknown().optional(),
  images: z.unknown().optional(),
})
const DiscogsTrack = z.object({
  title: Name,
  type_: z.string().optional().catch(undefined),
  position: z.string().max(60).optional().catch(undefined),
  duration: z.unknown().optional(),
  artists: z.unknown().optional(),
  extraartists: z.unknown().optional(),
  sub_tracks: z.unknown().optional(),
})
const DiscogsHit = z.object({
  id: NumberId,
  type: z.enum(['master', 'release', 'artist']),
  title: Name,
  year: IsoDate.optional().catch(undefined),
  thumb: z.string().optional().catch(undefined),
  master_id: NumberId.optional().catch(undefined),
})
function discogsCredits(value: unknown) {
  return objects(value, DiscogsArtist).map(
    ({ item }): Credit => ({
      name: item.name,
      externalId: item.id,
      role: item.role,
    }),
  )
}
function discogsLinks(item: {
  main_release?: string
  master_id?: string
}): MusicDiscovery[] {
  return [
    ...(item.main_release
      ? [
          relatedAlbum(
            'discogs',
            'release',
            item.main_release,
            'Discogs main release',
            'main_release',
          ),
        ]
      : []),
    ...(item.master_id
      ? [
          relatedAlbum(
            'discogs',
            'master',
            item.master_id,
            'Discogs master',
            'master',
          ),
        ]
      : []),
  ]
}
function discogsEdition(
  item: z.infer<typeof DiscogsEdition>,
  type: string,
  ordinal: number,
): MusicDiscovery {
  const tracks = objects(item.tracklist, DiscogsTrack).flatMap(
    ({ item: track }) =>
      track.type_ === 'index'
        ? objects(track.sub_tracks, DiscogsTrack).map(({ item }) => item)
        : track.type_ === 'heading'
          ? []
          : [track],
  )
  const nameLabels = (entries: unknown) =>
    objects(
      entries,
      ArtistName.extend({ catno: Name.optional().catch(undefined) }),
    )
      .map(({ item }) =>
        item.catno ? `${item.name} · ${item.catno}` : item.name,
      )
      .join(', ')
      .slice(0, 500)
  return {
    kind: 'album',
    provider: 'discogs',
    referenceType: type,
    externalId: item.id,
    title: item.title,
    ordinal,
    relationship: 'edition_detail',
    date: item.released ?? item.year,
    credits: [
      ...discogsCredits(item.artists),
      ...discogsCredits(item.extraartists),
    ],
    artworkUrl: webUrl(
      objects(item.images, z.object({ uri: z.string() }))[0]?.item.uri,
      /(?:^|\.)discogs\.com$/,
    )?.href,
    trackCount: tracks.length || undefined,
    details: {
      labels: nameLabels(item.labels) || null,
      companies: nameLabels(item.companies) || null,
    },
    children: [
      ...discogsLinks(item),
      ...tracks.map(
        (track, index): MusicDiscovery => ({
          kind: 'track',
          provider: 'discogs',
          referenceType: 'track',
          title: track.title,
          relationship: 'track_on_edition',
          ordinal: index + 1,
          durationSec: duration(track.duration),
          credits: [
            ...discogsCredits(track.artists),
            ...discogsCredits(track.extraartists),
          ],
          details: { nativePosition: track.position ?? null },
        }),
      ),
    ],
  }
}

const LastFmAlbum = z.object({
  name: Name,
  artist: z.union([Name, LastFmArtist]).optional().catch(undefined),
  mbid: AlbumMbidSchema.optional().catch(undefined),
  url: z.string().optional().catch(undefined),
  tracks: z.unknown().optional(),
})
const LastFmTrack = z.object({
  name: Name,
  artist: z.union([Name, LastFmArtist]).optional().catch(undefined),
  mbid: AlbumMbidSchema.optional().catch(undefined),
  url: z.string().optional().catch(undefined),
  duration: z.unknown().optional(),
  '@attr': z
    .object({ rank: z.coerce.number().int().positive().max(5000) })
    .optional()
    .catch(undefined),
})
function lastfmCredit(
  item: string | z.infer<typeof LastFmArtist> | undefined,
): Credit[] {
  if (!item) return []
  return typeof item === 'string'
    ? [{ name: item }]
    : [{ name: item.name, externalId: item.mbid }]
}
function lastfmTrack(
  item: z.infer<typeof LastFmTrack>,
  ordinal: number,
  relationship: string,
): MusicDiscovery {
  const url = webUrl(item.url, /^(?:www\.)?last\.fm$/)
  const exactTrackUrl =
    url?.pathname.startsWith('/music/') && url.pathname.includes('/_/')
      ? url.href
      : undefined
  return {
    kind: 'track',
    provider: 'lastfm',
    referenceType: item.mbid ? 'recording-mbid' : 'track-url',
    externalId: item.mbid ?? exactTrackUrl,
    title: item.name,
    url: exactTrackUrl,
    ordinal: item['@attr']?.rank ?? ordinal,
    relationship,
    durationSec: duration(item.duration),
    credits: lastfmCredit(item.artist),
  }
}
function lastfmAlbum(
  item: z.infer<typeof LastFmAlbum>,
  ordinal: number,
  relationship: string,
): MusicDiscovery {
  const url = webUrl(item.url, /^(?:www\.)?last\.fm$/)?.href
  const exactUrl = LastFmUrlSchema.safeParse(url).data
  const tracks = objects(object(item.tracks)?.track, LastFmTrack)
  return {
    kind: 'album',
    provider: 'lastfm',
    referenceType: item.mbid ? 'mbid' : 'url',
    externalId: item.mbid ?? exactUrl,
    title: item.name,
    ordinal,
    relationship,
    url: exactUrl,
    credits: lastfmCredit(item.artist),
    trackCount: tracks.length || undefined,
    children: tracks.map(({ item, ordinal }) =>
      lastfmTrack(item, ordinal, 'track_on_edition'),
    ),
  }
}

export function spotifyReleaseObservation(
  item: z.infer<typeof SpotifyAlbumSchema>,
  ordinal: number,
  relationship: string,
): MusicDiscovery {
  return {
    kind: 'album',
    provider: 'spotify',
    referenceType: 'spotify',
    externalId: item.id,
    title: item.name,
    ordinal,
    relationship,
    url: `https://open.spotify.com/album/${item.id}`,
    date: item.release_date,
    artworkUrl: item.images[0]?.url,
    trackCount: item.total_tracks,
    credits: item.artists.map(({ id, name }) => ({
      name,
      externalId: SpotifyIdSchema.safeParse(id).data,
    })),
    children: item.tracks?.items.map((track, index) => ({
      kind: 'track',
      provider: 'spotify',
      referenceType: 'track',
      externalId: track.id ?? undefined,
      title: track.name,
      ordinal: item.tracks ? item.tracks.offset + index + 1 : index + 1,
      relationship: 'track_on_edition',
      durationSec: Math.round(track.duration_ms / 1000),
      credits: track.artists.map(({ id, name }) => ({
        name,
        externalId: SpotifyIdSchema.safeParse(id).data,
      })),
      details: { disc: track.disc_number, nativePosition: track.track_number },
    })),
  }
}

function artistNode(
  provider: Provider,
  name: string,
  id: string | undefined,
  ordinal: number,
  relationship: string,
  url?: string,
): MusicDiscovery {
  return {
    kind: 'artist',
    provider,
    referenceType: 'artist',
    externalId: id,
    title: name,
    ordinal,
    relationship,
    url,
  }
}

function readMusicBrainz(
  url: URL,
  row: Record<string, unknown>,
): MusicDiscovery[] {
  const path = url.pathname
  const release = path.match(
    /^\/ws\/2\/(release-group|release)(?:\/([^/]+))?\/?$/,
  )
  if (release?.[1]) {
    const type = release[1]
    return objects(release[2] ? row : row[`${type}s`], MusicBrainzRelease).map(
      ({ item, ordinal }) =>
        mbRelease(
          item,
          ordinal,
          type,
          release[2] ? 'release_detail' : 'candidate',
        ),
    )
  }
  if (/^\/ws\/2\/artist(?:\/[^/]+)?\/?$/.test(path))
    return objects(
      row.artists ?? row,
      MbArtist.extend({ relations: z.unknown().optional() }),
    ).map(({ item, ordinal }) => ({
      ...artistNode(
        'musicbrainz',
        item.name,
        item.id,
        ordinal,
        row.artists ? 'candidate' : 'artist_profile',
      ),
      children: mbRelations(item.relations),
    }))
  return []
}

function readDiscogs(url: URL, row: Record<string, unknown>): MusicDiscovery[] {
  if (url.pathname === '/database/search')
    return objects(row.results, DiscogsHit).map(({ item, ordinal }) => {
      if (item.type === 'artist')
        return artistNode('discogs', item.title, item.id, ordinal, 'candidate')
      const [prefix, ...rest] = item.title.split(' - ')
      return {
        kind: 'album',
        provider: 'discogs',
        referenceType: item.type,
        externalId: item.id,
        title: rest.length ? rest.join(' - ') : item.title,
        date: item.year,
        relationship: 'candidate',
        ordinal,
        artworkUrl: webUrl(item.thumb, /(?:^|\.)discogs\.com$/)?.href,
        credits: rest.length && prefix ? [{ name: prefix }] : [],
        children: discogsLinks(item),
      }
    })
  const type = url.pathname.match(/^\/(masters|releases)\/\d+\/?$/)?.[1]
  if (type)
    return objects(row, DiscogsEdition).map(({ item, ordinal }) =>
      discogsEdition(item, type === 'masters' ? 'master' : 'release', ordinal),
    )
  if (/^\/artists\/\d+\/?$/.test(url.pathname))
    return objects(
      row,
      DiscogsArtist.extend({
        members: z.unknown().optional(),
        groups: z.unknown().optional(),
      }),
    ).map(({ item, ordinal }) => ({
      ...artistNode('discogs', item.name, item.id, ordinal, 'artist_profile'),
      children: [
        ...objects(item.members, DiscogsArtist).map(({ item, ordinal }) =>
          artistNode('discogs', item.name, item.id, ordinal, 'member'),
        ),
        ...objects(item.groups, DiscogsArtist).map(({ item, ordinal }) =>
          artistNode('discogs', item.name, item.id, ordinal, 'group'),
        ),
      ],
    }))
  return []
}

function lastfmArtistNode(
  item: z.infer<typeof LastFmArtist>,
  ordinal: number,
  relationship: string,
) {
  const url = webUrl(item.url, /^(?:www\.)?last\.fm$/)
  const artistUrl =
    url && /^\/music\/[^/]+\/?$/.test(url.pathname) ? url.href : undefined
  return artistNode(
    'lastfm',
    item.name,
    item.mbid ?? artistUrl,
    ordinal,
    relationship,
    artistUrl,
  )
}
function readLastfm(url: URL, row: Record<string, unknown>): MusicDiscovery[] {
  switch (url.searchParams.get('method')?.toLowerCase()) {
    case 'album.getinfo':
      return objects(row.album, LastFmAlbum).map(({ item, ordinal }) =>
        lastfmAlbum(item, ordinal, 'release_detail'),
      )
    case 'album.search':
      return objects(
        object(object(row.results)?.albummatches)?.album,
        LastFmAlbum,
      ).map(({ item, ordinal }) => lastfmAlbum(item, ordinal, 'candidate'))
    case 'artist.search':
      return objects(
        object(object(row.results)?.artistmatches)?.artist,
        LastFmArtist,
      ).map(({ item, ordinal }) => lastfmArtistNode(item, ordinal, 'candidate'))
    case 'artist.getinfo':
      return objects(
        row.artist,
        LastFmArtist.extend({ similar: z.unknown().optional() }),
      ).map(({ item, ordinal }) => ({
        ...lastfmArtistNode(item, ordinal, 'artist_profile'),
        children: objects(object(item.similar)?.artist, LastFmArtist).map(
          ({ item, ordinal }) => lastfmArtistNode(item, ordinal, 'similar'),
        ),
      }))
    case 'artist.gettoptracks':
      return objects(object(row.toptracks)?.track, LastFmTrack).map(
        ({ item, ordinal }) => lastfmTrack(item, ordinal, 'top_track'),
      )
    case 'track.getinfo':
      return objects(row.track, LastFmTrack).map(({ item, ordinal }) =>
        lastfmTrack(item, ordinal, 'recording_detail'),
      )
    default:
      return []
  }
}

function readSpotify(
  url: URL,
  row: Record<string, unknown>,
  phase: MusicResponseSource['phase'],
): MusicDiscovery[] {
  if (
    url.pathname === '/v1/search' &&
    url.searchParams.get('type') === 'artist'
  )
    return objects(object(row.artists)?.items, SpotifyArtist).map(
      ({ item, ordinal }) =>
        artistNode('spotify', item.name, item.id, ordinal, 'candidate'),
    )
  if (/^\/v1\/artists\/[a-zA-Z0-9]{22}$/.test(url.pathname))
    return objects(row, SpotifyArtist).map(({ item, ordinal }) =>
      artistNode('spotify', item.name, item.id, ordinal, 'artist_profile'),
    )
  if (phase === 'media') {
    if (
      url.pathname === '/v1/search' &&
      url.searchParams.get('type') === 'album'
    )
      return objects(object(row.albums)?.items, SpotifyAlbumSchema).map(
        ({ item, ordinal }) =>
          spotifyReleaseObservation(item, ordinal, 'candidate'),
      )
    if (/^\/v1\/albums\/[a-zA-Z0-9]{22}$/.test(url.pathname))
      return objects(row, SpotifyAlbumSchema).map(({ item, ordinal }) =>
        spotifyReleaseObservation(item, ordinal, 'release_detail'),
      )
  }
  return []
}

/** Account, credential and billing paths are excluded before decoding. */
export function musicResponseEndpoint(source: MusicResponseSource) {
  const provider = Provider.safeParse(source.provider)
  if (
    !provider.success ||
    source.method !== 'GET' ||
    source.status === null ||
    source.status < 200 ||
    source.status >= 300
  )
    return
  if (!source.requestUrl) return
  try {
    const url = new URL(source.requestUrl)
    const origins: Record<Provider, string> = {
      musicbrainz: 'https://musicbrainz.org',
      discogs: 'https://api.discogs.com',
      lastfm: 'https://ws.audioscrobbler.com',
      serply: 'https://api.serply.io',
      spotify: 'https://api.spotify.com',
    }
    if (url.origin !== origins[provider.data] || url.username || url.password)
      return
    if (
      provider.data === 'lastfm' &&
      !/^(?:album|artist|track)\./i.test(url.searchParams.get('method') ?? '')
    )
      return
    if (
      provider.data === 'spotify' &&
      !/^\/v1\/(?:search$|artists\/|albums\/)/.test(url.pathname)
    )
      return
    return { url, provider: provider.data, phase: source.phase }
  } catch {
    return
  }
}

export function readMusicDiscoveries(
  endpoint: NonNullable<ReturnType<typeof musicResponseEndpoint>>,
  payload: unknown,
): MusicDiscovery[] {
  const row = object(payload)
  if (!row) return []
  const { url, provider, phase } = endpoint
  switch (provider) {
    case 'musicbrainz':
      return readMusicBrainz(url, row)
    case 'discogs':
      return readDiscogs(url, row)
    case 'lastfm':
      return readLastfm(url, row)
    case 'spotify':
      return readSpotify(url, row, phase)
    case 'serply':
      if (!/^\/v1\/search\/?$/.test(url.pathname)) return []
      try {
        return readSerplyPageResults(row).flatMap(({ title, link }, index) => {
          const release = albumLink(link, index + 1, 'indexed_release')
          const name = Name.safeParse(title)
          return release?.provider === 'rym' &&
            name.success &&
            !/music-review|\/single-review\//i.test(link)
            ? [{ ...release, title: name.data }]
            : []
        })
      } catch {
        return []
      }
  }
}
