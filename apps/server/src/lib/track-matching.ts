import type {
  TrackAlbumLinkStrategy,
  TrackScrobbleLinkStrategy,
} from '@repo/schemas/tracks'
import { albumNameKey } from './album-import-candidates'
import { artistKeys, baseTitleKey, plainKey } from './lastfm-album-matching'

const BRACKETED = /[([]([^()[\]]*)[)\]]/g
const DASH = /\s+[-–—]\s+/
const INLINE_FEATURE = /\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i
// A featured credit, a remaster note or the default mix names the same recording.
const SAME_RECORDING =
  /^(?:(?:feat\.?|ft\.?|featuring|with)\s|.*\bremaster(?:ed)?\b|original(?: mix| version)?$|album version$|bonus track$|explicit$|clean$)/i

function titleParts(title: string) {
  const qualifiers: string[] = []
  const unbracketed = title.replace(BRACKETED, (_match, inner: string) => {
    qualifiers.push(inner)
    return ' '
  })
  const [base = '', ...tail] = unbracketed.split(DASH)
  return {
    base: base.replace(INLINE_FEATURE, '').trim(),
    qualifiers: [...tail, ...qualifiers]
      .map((qualifier) => qualifier.trim())
      .filter(Boolean),
  }
}

/**
 * The title without qualifiers that name the same recording. Mixes, edits,
 * live and other versions stay part of the title, in any punctuation.
 */
export function trackVersionKey(title: string) {
  const { base, qualifiers } = titleParts(title)
  if (!base) return plainKey(title)
  return [
    plainKey(base),
    ...qualifiers
      .filter((qualifier) => !SAME_RECORDING.test(qualifier))
      .map(plainKey)
      .sort(),
  ].join(' ')
}

/** The title without any qualifier. */
export function trackBaseKey(title: string) {
  const { base } = titleParts(title)
  return plainKey(base || title)
}

function add(map: Map<string, Set<string>>, key: string, value: string) {
  const values = map.get(key)
  if (values) values.add(value)
  else map.set(key, new Set([value]))
}

const pair = (left: string, right: string) => `${left}\u0000${right}`

export type MatchLibraryTrack = {
  id: string
  title: string
  artists: string[]
  /** The linked library album. */
  albumId: string | null
}

export type ScrobbledTrack = {
  artistName: string
  trackName: string
  /** Library albums the name's scrobbles are linked to. */
  albumIds: string[]
}

export type ScrobbleTrackMatch = {
  trackIds: string[]
  strategy: TrackScrobbleLinkStrategy
}

/**
 * Builds a matcher from the track library. A scrobbled artist and track name
 * counts towards every track the first fitting rule finds, so two Spotify
 * listings of one recording share its scrobbles.
 */
export function createScrobbleTrackMatcher(tracks: MatchLibraryTrack[]) {
  const exact = new Map<string, Set<string>>()
  const normalized = new Map<string, Set<string>>()
  const version = new Map<string, Set<string>>()
  const onAlbum = new Map<string, Set<string>>()
  for (const track of tracks) {
    const plainTitle = plainKey(track.title)
    const versionTitle = trackVersionKey(track.title)
    for (const artist of track.artists) {
      add(
        exact,
        pair(albumNameKey(artist), albumNameKey(track.title)),
        track.id,
      )
      for (const key of artistKeys(artist)) {
        add(normalized, pair(key, plainTitle), track.id)
        add(version, pair(key, versionTitle), track.id)
      }
    }
    if (track.albumId)
      add(onAlbum, pair(track.albumId, trackBaseKey(track.title)), track.id)
  }

  return function match(scrobbled: ScrobbledTrack): ScrobbleTrackMatch | null {
    const found = (
      ids: Iterable<string>,
      strategy: TrackScrobbleLinkStrategy,
    ) => {
      const trackIds = [...new Set(ids)].sort()
      return trackIds.length ? { trackIds, strategy } : null
    }
    const artists = artistKeys(scrobbled.artistName)
    const byArtist = (map: Map<string, Set<string>>, title: string) =>
      artists.flatMap((key) => [...(map.get(pair(key, title)) ?? [])])
    const baseTitle = trackBaseKey(scrobbled.trackName)
    return (
      found(
        exact.get(
          pair(
            albumNameKey(scrobbled.artistName),
            albumNameKey(scrobbled.trackName),
          ),
        ) ?? [],
        'exact',
      ) ??
      found(
        byArtist(normalized, plainKey(scrobbled.trackName)),
        'normalized',
      ) ??
      found(
        byArtist(version, trackVersionKey(scrobbled.trackName)),
        'version',
      ) ??
      found(
        scrobbled.albumIds.flatMap((albumId) => {
          // Two versions of a title on one album cannot be told apart here.
          const ids = onAlbum.get(pair(albumId, baseTitle))
          return ids?.size === 1 ? [...ids] : []
        }),
        'album',
      )
    )
  }
}

export type MatchTrackAlbum = {
  id: string
  title: string
  releaseDate: string | null
  artists: string[]
  spotifyAlbumIds: string[]
  tracks: Array<{ title: string; externalId: string | null }>
}

export type TrackToLink = {
  spotifyTrackId: string | null
  spotifyAlbumId: string | null
  title: string
  albumName: string | null
  artists: string[]
}

export type TrackAlbumMatch = {
  albumId: string
  strategy: TrackAlbumLinkStrategy
}

type IndexedAlbum = {
  id: string
  plainTitle: string
  baseTitle: string
  releaseDate: string | null
  tracks: Set<string>
}

function first(
  albums: IndexedAlbum[],
  rank: (album: IndexedAlbum) => number = () => 0,
) {
  // The original release is the earliest; an undated album sorts last.
  return [...albums].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      (left.releaseDate ?? '9999').localeCompare(right.releaseDate ?? '9999') ||
      left.id.localeCompare(right.id),
  )[0]
}

function push(
  map: Map<string, IndexedAlbum[]>,
  key: string,
  album: IndexedAlbum,
) {
  const list = map.get(key)
  if (list) list.push(album)
  else map.set(key, [album])
}

/**
 * Builds a matcher from the library's albums. A track links to one album by
 * Spotify ID, then by album title, then by a credited artist's track title;
 * see `TrackAlbumLinkStrategySchema`.
 */
export function createTrackAlbumMatcher(albums: MatchTrackAlbum[]) {
  const bySpotifyAlbum = new Map<string, IndexedAlbum[]>()
  const bySpotifyTrack = new Map<string, IndexedAlbum[]>()
  const byArtist = new Map<string, IndexedAlbum[]>()
  for (const album of albums) {
    const indexed: IndexedAlbum = {
      id: album.id,
      plainTitle: plainKey(album.title),
      baseTitle: baseTitleKey(album.title),
      releaseDate: album.releaseDate,
      tracks: new Set(
        album.tracks.map((track) => trackVersionKey(track.title)),
      ),
    }
    for (const id of album.spotifyAlbumIds) push(bySpotifyAlbum, id, indexed)
    for (const track of album.tracks)
      if (track.externalId) push(bySpotifyTrack, track.externalId, indexed)
    for (const key of new Set(album.artists.flatMap(artistKeys)))
      push(byArtist, key, indexed)
  }

  return function match(track: TrackToLink): TrackAlbumMatch | null {
    const link = (
      album: IndexedAlbum | undefined,
      strategy: TrackAlbumLinkStrategy,
    ) => (album ? { albumId: album.id, strategy } : null)
    const credited = [
      ...new Set(
        track.artists
          .flatMap(artistKeys)
          .flatMap((key) => byArtist.get(key) ?? []),
      ),
    ]
    const title = trackVersionKey(track.title)
    const albumName = track.albumName
    return (
      link(
        first(
          track.spotifyAlbumId
            ? (bySpotifyAlbum.get(track.spotifyAlbumId) ?? [])
            : [],
        ),
        'spotify-album',
      ) ??
      link(
        first(
          track.spotifyTrackId
            ? (bySpotifyTrack.get(track.spotifyTrackId) ?? [])
            : [],
        ),
        'spotify-track',
      ) ??
      (albumName
        ? link(
            first(
              credited.filter(
                (album) =>
                  album.baseTitle === baseTitleKey(albumName) &&
                  // An album without a stored track list matches on its title.
                  (album.tracks.size === 0 || album.tracks.has(title)),
              ),
              (album) => (album.plainTitle === plainKey(albumName) ? 0 : 1),
            ),
            'album-title',
          )
        : null) ??
      link(
        first(credited.filter((album) => album.tracks.has(title))),
        'artist-title',
      )
    )
  }
}
