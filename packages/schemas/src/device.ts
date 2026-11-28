import { z } from 'zod'
import { BrowseFieldSchema } from './browse'
import { ArtistSummarySchema } from './creators'
import { AlbumListItemSchema, FilmListItemSchema } from './media'
import {
  PlaylistSummarySchema,
  PlaylistSyncSchema,
  SpotifyPlaylistJobSchema,
  TrackListItemSchema,
} from './tracks'

/**
 * The device store contract (docs/requirements/device-store.md). The server
 * publishes one row per entity and ID; a device keeps them in SQLite and
 * answers Browse reads from them.
 *
 * Every projection field below names the server expression it must equal.
 * Paths are under `apps/server/src/services/` unless they say otherwise;
 * the shared Browse expressions named for browse.ts are in
 * browse-expressions.ts, which browse.ts imports. The server fills each field from that expression, never from a copy, so
 * the feed and the Browse services cannot drift.
 *
 * Conventions for projection values:
 * - Text values are the raw strings the expression yields, distinct by exact
 *   value, in code-point order. The device folds them for comparison.
 * - Dates are whole epoch microseconds, `extract(epoch from value) * 1000000`,
 *   the stored precision and exact in a double. The device multiplies a
 *   range bound, which arrives in milliseconds, by 1000 before comparing.
 * - Sort values are the finished primary value, already passed through the
 *   service's `lower()`, so the device only compares them by code point.
 * - Null means no value: ranges treat it as missing and sorts put it last.
 */

/** Bump when a payload shape or the meaning of a projection field changes. */
export const DEVICE_ROW_VERSION = 1

export const DeviceEntitySchema = z.enum([
  'track',
  'album',
  'film',
  'artist',
  'playlist',
  'playlist_job',
  'tag',
  'tag_key',
  'scrobble_name',
  'album_plays',
  'artist_plays',
  'meta',
])
export type DeviceEntity = z.infer<typeof DeviceEntitySchema>

const DeviceSeqSchema = z.number().int().nonnegative()
const DeviceTextSchema = z.array(z.string())
const DeviceIdsSchema = z.array(z.string().min(1))
const DeviceNumberSchema = z.number().finite().nullable()
const DeviceSortTextSchema = z.string().nullable()

/** A Tags location: Auto, or `tagLevels` as its URL parameter writes it. */
export const DeviceTagLocationSchema = z.enum([
  'auto',
  'track',
  'album',
  'artist',
  'track,album',
  'track,artist',
  'album,artist',
  'track,album,artist',
])
export type DeviceTagLocation = z.infer<typeof DeviceTagLocationSchema>

/** The Tags sort value at each location; Track on Albums is the album's library tracks' own tags. */
const DeviceTagSortSchema = z
  .object({
    auto: DeviceSortTextSchema,
    track: DeviceSortTextSchema,
    album: DeviceSortTextSchema,
    artist: DeviceSortTextSchema,
    'track,album': DeviceSortTextSchema,
    'track,artist': DeviceSortTextSchema,
    'album,artist': DeviceSortTextSchema,
    'track,album,artist': DeviceSortTextSchema,
  })
  .strict()

// Tracks

/** The list item without the fields that depend on the request. */
export const DeviceTrackItemSchema = TrackListItemSchema.omit({
  listeningScrobbles: true,
  recordingGroup: true,
  links: true,
})

/** Filter values. Tags, Track tags, Album tags and Artist tags match through `extra`. */
const DeviceTrackTextSchema = z
  .object({
    // matchesValue('title'), browse.ts: lower(media_item.title)
    title: DeviceTextSchema,
    // textRows('source', 'track'), browse.ts: the labels matchesValue('source') tests
    source: DeviceTextSchema,
    // trackSpotifyMatchExpression(labels), track-values.ts
    spotifyMatch: DeviceTextSchema,
    // trackProviderRows, track-values.ts; the filter is trackIdsWithProvider
    provider: DeviceTextSchema,
    // textRows('artist'), browse.ts: credited names with role artist
    artist: DeviceTextSchema,
    // trackValueExpression('album'), browse.ts: coalesce(album_name, linked album title)
    album: DeviceTextSchema,
    // textRows('playlist'), browse.ts: direct members of kind playlist
    playlist: DeviceTextSchema,
    // trackValueExpression('albumLink'), browse.ts
    albumLink: DeviceTextSchema,
    // trackValueExpression('hasTrackTags'), browse.ts: from library_track.has_own_tags
    hasTrackTags: DeviceTextSchema,
    // verifiedTrackKeyRows, track-facts.ts: the verified Camelot key
    musicalKey: DeviceTextSchema,
  })
  .strict()

/** `q` values that differ from `text`; title, source, spotifyMatch, artist, album, playlist and albumLink search `text`. */
const DeviceTrackSearchSchema = z
  .object({
    // browseTextSearchIds('trackTag'), browse.ts: non-hidden names of in_browse track tags
    trackTag: DeviceTextSchema,
    // browseTextSearchIds('albumTag'), browse.ts: non-hidden tag names of the linked album
    albumTag: DeviceTextSchema,
    // artistTagLabels(), music-tags.ts: every projected label of the credited artists
    artistTag: DeviceTextSchema,
  })
  .strict()

const DeviceTrackNumberSchema = z
  .object({
    // numericExpression('releaseDate', 'track'), browse.ts: track date first
    releaseDate: DeviceNumberSchema,
    // numericExpression('dateAdded', 'track'), browse.ts: library_track.date_added
    dateAdded: DeviceNumberSchema,
    // numericExpression('durationSec', 'track'), browse.ts
    durationSec: DeviceNumberSchema,
    // verifiedTrackBpm, track-facts.ts
    bpm: DeviceNumberSchema,
    // numericExpression('scrobbles', 'track'), browse.ts: library_track.scrobble_count
    scrobbles: DeviceNumberSchema,
    // numericExpression('lastListenedAt', 'track'), browse.ts
    lastListenedAt: DeviceNumberSchema,
  })
  .strict()

/**
 * The parts of trackNaturalOrder, browse.ts, not held elsewhere. The device
 * builds the tuple as the service does: a prefix chosen by the primary sort
 * from `artist`, `year`, `sort.album` and `albumDate`, then `extra.albumId`,
 * `spotifyAlbumId`, `position`, `sort.title`, then the ID.
 */
const DeviceTrackNaturalOrderSchema = z
  .object({
    // firstTrackArtist(coalesce(album_media_item_id, id)), browse.ts
    artist: DeviceSortTextSchema,
    // trackNaturalOrder albumDate, browse.ts: the linked album's release date, else the track's
    albumDate: DeviceNumberSchema,
    // trackNaturalOrder year, browse.ts: extract(year from albumDate)
    year: DeviceNumberSchema,
    // trackNaturalOrder, browse.ts: spotify_album_id when the track has no linked album
    spotifyAlbumId: DeviceSortTextSchema,
    // trackNaturalOrder position, browse.ts: min(track.position) on the linked album
    position: DeviceNumberSchema,
  })
  .strict()

/** Sort keys whose value is not a `num` value; dateAdded, durationSec, bpm, scrobbles and lastListenedAt use `num`. */
const DeviceTrackSortSchema = z
  .object({
    // browseSortExpression('title'), browse.ts: lower(title)
    title: DeviceSortTextSchema,
    // directSortExpression('artist'), browse.ts: firstTrackArtist(id)
    artist: DeviceSortTextSchema,
    // directSortExpression('album'), browse.ts: trackAlbumSortName, linked title first
    album: DeviceSortTextSchema,
    // directSortExpression('releaseDate', 'track'), browse.ts: album date first
    releaseDate: DeviceNumberSchema,
    // tagLocationOrderRows('track', levels), browse.ts, as lower(min(name)) per location
    genre: DeviceTagSortSchema,
    // browseOrderRows('artistTag'), browse.ts
    artistTag: DeviceSortTextSchema,
    // browseOrderRows('trackTag'), browse.ts
    trackTag: DeviceSortTextSchema,
    // browseOrderRows('albumTag', 'track'), browse.ts
    albumTag: DeviceSortTextSchema,
    // browseOrderRows('playlist', 'track'), browse.ts
    playlist: DeviceSortTextSchema,
    // browseOrderRows('source', 'track'), browse.ts
    source: DeviceSortTextSchema,
    // browseOrderRows('provider', 'track'), browse.ts
    provider: DeviceSortTextSchema,
    // browseSortExpression('spotifyMatch'), browse.ts: lower(label)
    spotifyMatch: DeviceSortTextSchema,
    // browseSortExpression('albumLink'), browse.ts: lower(label)
    albumLink: DeviceSortTextSchema,
    // browseSortExpression('hasTrackTags'), browse.ts: lower(label)
    hasTrackTags: DeviceSortTextSchema,
    // verifiedTrackKeyPosition, track-facts.ts
    musicalKey: DeviceNumberSchema,
    natural: DeviceTrackNaturalOrderSchema,
  })
  .strict()

/** Recording group evidence under the default scope; see recordingMemberships, recording-groups.ts. */
const DeviceRecordingSchema = z
  .object({
    // recording_group_members.group_key with includePeerMembers over every visible track; null when in no group
    key: z.string().min(1).nullable(),
    // recordingRepresentatives, recording-groups.ts: library_track.version_shown
    shown: z.boolean(),
    // recordingRepresentatives: library_track.spotify_track_id is not null
    playable: z.boolean(),
    // recordingRepresentatives: library_track.album_media_item_id is not null
    linked: z.boolean(),
    // recordingRepresentatives: coalesce(album release_date, track release_date)
    releaseDate: DeviceNumberSchema,
  })
  .strict()

const DeviceTrackExtraSchema = z
  .object({
    // browseQueries, browse.ts: metadata->>'legacyHidden' = 'true'
    archived: z.boolean(),
    // browseQueries visibleTrack, browse.ts: source_label = 'lastfm' and id in redundantLastfmTrackIds(), track-values.ts
    redundantPlaceholder: z.boolean(),
    // library_track.album_media_item_id; the album the tag levels and fallback read
    albumId: z.string().min(1).nullable(),
    // media_credit with role artist, by billing order then artist ID; creator scope and facet credit sets
    artistIds: DeviceIdsSchema,
    // library_track.has_own_tags: trackIdsWithTag Auto, music-tags.ts
    hasOwnTags: z.boolean(),
    // trackIdsWithTag own, music-tags.ts: track_tag.tag_id where in_browse, any hidden state
    ownTagIds: DeviceIdsSchema,
    // trackIdsWithTag inherits, music-tags.ts: track_tag.tag_id where in_browse and sonovault
    ownSonovaultTagIds: DeviceIdsSchema,
    // trackIdsWithTag albums, music-tags.ts: media_item_tag.tag_id of the linked album, any hidden state
    albumTagIds: DeviceIdsSchema,
    // albumsWithEnoughTags, music-tags.ts: release tag keys of the linked album; null without one
    albumReleaseTagCount: z.number().int().nonnegative().nullable(),
    // mediaIdsWithArtistTag, music-tags.ts: artist_profile_tag_keys of the credited artists' current snapshots
    artistTagKeys: DeviceTextSchema,
    // artistTagMemberships('track').name_key, music-tags.ts: projected keys before ancestors, for facets
    artistTagLabelKeys: DeviceTextSchema,
    recording: DeviceRecordingSchema,
    // lastfm_track_link names of this track, as `scrobble_name` IDs: hasBrowseScrobbles, browse-listening.ts
    scrobbleNameIds: DeviceIdsSchema,
  })
  .strict()

export const DeviceTrackRowSchema = z
  .object({
    item: DeviceTrackItemSchema,
    text: DeviceTrackTextSchema,
    search: DeviceTrackSearchSchema,
    num: DeviceTrackNumberSchema,
    sort: DeviceTrackSortSchema,
    extra: DeviceTrackExtraSchema,
  })
  .strict()
export type DeviceTrackRow = z.infer<typeof DeviceTrackRowSchema>

// Albums

export const DeviceAlbumItemSchema = AlbumListItemSchema.omit({
  listeningScrobbles: true,
})

/**
 * Filter and search values. Every key of `media_item.metadata->'browse'`
 * that is not a built-in field or a Spotify audio feature is also present,
 * as storedBrowseField(key) elements as text, browse.ts. A plugin field the
 * row lacks has no value; a field missing from `meta` `fields:album` is
 * unknown and falls through.
 */
const DeviceAlbumTextSchema = z
  .object({
    // matchesValue('title'), browse.ts
    title: DeviceTextSchema,
    // textRows('artist'), browse.ts
    artist: DeviceTextSchema,
    // storedBrowseField('country', 'album'), browse.ts: metadata.browse elements
    country: DeviceTextSchema,
    // albumPlaylistRows(), browse.ts: direct, through a library track and through a track list
    playlist: DeviceTextSchema,
    // textRows('collection'), browse.ts: direct members of kind collection
    collection: DeviceTextSchema,
    // valueExpression('source', 'album'), browse.ts: source_label
    source: DeviceTextSchema,
    // textRows('provider'), browse.ts: provider_reference.provider, any reference type
    provider: DeviceTextSchema,
    // valueExpression('edition', 'album'), browse.ts
    edition: DeviceTextSchema,
  })
  .catchall(DeviceTextSchema)

/** `q` values that differ from `text`. Edition and Tags are not searched. */
const DeviceAlbumSearchSchema = z
  .object({
    // textRows('albumTag', 'album'), browse.ts: non-hidden tag names
    albumTag: DeviceTextSchema,
    // artistTagLabels(), music-tags.ts, for the credited artists
    artistTag: DeviceTextSchema,
  })
  .strict()

/** Range values; plugin numbers are present as storedBrowseNumber(key), browse.ts. */
const DeviceAlbumNumberSchema = z
  .object({
    // numericExpression('releaseDate', 'album'), browse.ts
    releaseDate: DeviceNumberSchema,
    // albumAddedDateExpression, album-added-dates.ts: least ignores nulls
    dateAdded: DeviceNumberSchema,
    // numericExpression('durationSec', 'album'), browse.ts
    durationSec: DeviceNumberSchema,
    // numericExpression('trackCount'), browse.ts
    trackCount: DeviceNumberSchema,
    // storedBrowseNumber(key, 'album'), browse.ts, for each of the following
    scrobbles: DeviceNumberSchema,
    lastListenedAt: DeviceNumberSchema,
    scrobblesLast1y: DeviceNumberSchema,
    scrobblesLast5y: DeviceNumberSchema,
    ratingRymValue: DeviceNumberSchema,
    ratingRymVotes: DeviceNumberSchema,
    ratingDiscogsValue: DeviceNumberSchema,
    ratingDiscogsVotes: DeviceNumberSchema,
    // storedBrowseField Metacritic rule, browse.ts: null after a rejected match
    ratingMetacriticValue: DeviceNumberSchema,
    ratingMetacriticVotes: DeviceNumberSchema,
    popularityDiscogs: DeviceNumberSchema,
    popularitySpotify: DeviceNumberSchema,
    popularityLastFm: DeviceNumberSchema,
  })
  .catchall(DeviceNumberSchema)

/** Text sort values; plugin text keys are present as lower(textExpression(key)), browse.ts. Numbers use `num`. */
const DeviceAlbumSortSchema = z
  .object({
    // browseSortExpression('title'), browse.ts
    title: DeviceSortTextSchema,
    // lower(textExpression('artist', 'album')), browse.ts: first by billing order
    artist: DeviceSortTextSchema,
    // lower(textExpression('country', 'album')), browse.ts
    country: DeviceSortTextSchema,
    // browseOrderRows('playlist', 'album'), browse.ts
    playlist: DeviceSortTextSchema,
    // browseOrderRows('collection', 'album'), browse.ts
    collection: DeviceSortTextSchema,
    // lower(textExpression('source', 'album')), browse.ts
    source: DeviceSortTextSchema,
    // lower(textExpression('provider', 'album')), browse.ts
    provider: DeviceSortTextSchema,
    // lower(textExpression('edition', 'album')), browse.ts
    edition: DeviceSortTextSchema,
    // browseOrderRows('albumTag', 'album'), browse.ts
    albumTag: DeviceSortTextSchema,
    // browseOrderRows('artistTag', 'album'), browse.ts
    artistTag: DeviceSortTextSchema,
    // tagLocationOrderRows('album', levels), browse.ts; Auto is firstMusicTagRows('album'), music-tags.ts
    genre: DeviceTagSortSchema,
  })
  .catchall(DeviceSortTextSchema)

const DeviceAlbumExtraSchema = z
  .object({
    // browseQueries, browse.ts: metadata->>'legacyHidden' = 'true'
    archived: z.boolean(),
    // browseQueries edition rule, browse.ts: album.edition_of_id is not null
    isEdition: z.boolean(),
    // media_credit with role artist, by billing order then artist ID
    artistIds: DeviceIdsSchema,
    // matchesValue('genre', 'album'), browse.ts: media_item_tag.tag_id, any hidden state
    tagIds: DeviceIdsSchema,
    // albumsWithEnoughTags, music-tags.ts: release tag keys of the album
    releaseTagCount: z.number().int().nonnegative(),
    // mediaIdsWithArtistTag, music-tags.ts
    artistTagKeys: DeviceTextSchema,
    // artistTagMemberships('album').name_key, music-tags.ts
    artistTagLabelKeys: DeviceTextSchema,
    // albumIdsWithTag track level, music-tags.ts: in_browse track tags of every library track linked to the album
    trackTagIds: DeviceIdsSchema,
  })
  .strict()

export const DeviceAlbumRowSchema = z
  .object({
    item: DeviceAlbumItemSchema,
    text: DeviceAlbumTextSchema,
    search: DeviceAlbumSearchSchema,
    num: DeviceAlbumNumberSchema,
    sort: DeviceAlbumSortSchema,
    extra: DeviceAlbumExtraSchema,
  })
  .strict()
export type DeviceAlbumRow = z.infer<typeof DeviceAlbumRowSchema>

// Films

export const DeviceFilmItemSchema = FilmListItemSchema

/** Filter and search values, plugin text keys as on Albums. Tags match through `extra`. */
const DeviceFilmTextSchema = z
  .object({
    // valueExpression('summary'), browse.ts; searched, and a filter on it is accepted
    summary: DeviceTextSchema,
    // matchesValue('title'), browse.ts
    title: DeviceTextSchema,
    // textRows(role), browse.ts, for each credit role
    director: DeviceTextSchema,
    actor: DeviceTextSchema,
    writer: DeviceTextSchema,
    // storedBrowseField(key, 'film'), browse.ts, for each of the following
    country: DeviceTextSchema,
    language: DeviceTextSchema,
    productionCompany: DeviceTextSchema,
    awards: DeviceTextSchema,
    // textRows('collection'), browse.ts
    collection: DeviceTextSchema,
    // textRows('playlist'), browse.ts: direct members of kind playlist
    playlist: DeviceTextSchema,
    // valueExpression('source', 'film'), browse.ts: coalesce(source_label, film.source_kind)
    source: DeviceTextSchema,
    // valueExpression('watched'), browse.ts
    watched: DeviceTextSchema,
    // valueExpression('identification'), browse.ts
    identification: DeviceTextSchema,
    // textRows('provider'), browse.ts
    provider: DeviceTextSchema,
  })
  .catchall(DeviceTextSchema)

const DeviceFilmSearchSchema = z
  .object({
    // textRows('genre', 'film'), browse.ts: non-hidden film tag names
    genre: DeviceTextSchema,
  })
  .strict()

const DeviceFilmNumberSchema = z
  .object({
    // numericExpression('releaseDate', 'film'), browse.ts
    releaseDate: DeviceNumberSchema,
    // numericExpression('dateAdded', 'film'), browse.ts: coalesce(film.date_added, created_at)
    dateAdded: DeviceNumberSchema,
    // numericExpression('updatedAt'), browse.ts
    updatedAt: DeviceNumberSchema,
    // numericExpression, browse.ts: film columns
    runtimeMinutes: DeviceNumberSchema,
    budget: DeviceNumberSchema,
    boxOffice: DeviceNumberSchema,
    // storedBrowseNumber(key, 'film'), browse.ts, for each of the following
    ratingImdbPersonal: DeviceNumberSchema,
    ratingImdbPersonalDate: DeviceNumberSchema,
    ratingImdbValue: DeviceNumberSchema,
    ratingImdbVotes: DeviceNumberSchema,
    ratingMetascore: DeviceNumberSchema,
    ratingTmdbValue: DeviceNumberSchema,
    ratingTmdbVotes: DeviceNumberSchema,
    popularityTmdb: DeviceNumberSchema,
    ratingRt: DeviceNumberSchema,
    ratingMetacriticUser: DeviceNumberSchema,
    ratingMetacriticUserVotes: DeviceNumberSchema,
    ratingTrakt: DeviceNumberSchema,
    ratingTraktVotes: DeviceNumberSchema,
    ratingLetterboxd: DeviceNumberSchema,
    ratingLetterboxdVotes: DeviceNumberSchema,
    ratingRtAudience: DeviceNumberSchema,
    ratingRtAudienceVotes: DeviceNumberSchema,
  })
  .catchall(DeviceNumberSchema)

/** Text sort values, plugin text keys as on Albums. Numbers use `num`. */
const DeviceFilmSortSchema = z
  .object({
    // lower(textExpression(key, 'film')), browse.ts, for each of the following
    summary: DeviceSortTextSchema,
    title: DeviceSortTextSchema,
    director: DeviceSortTextSchema,
    actor: DeviceSortTextSchema,
    writer: DeviceSortTextSchema,
    country: DeviceSortTextSchema,
    language: DeviceSortTextSchema,
    productionCompany: DeviceSortTextSchema,
    awards: DeviceSortTextSchema,
    source: DeviceSortTextSchema,
    watched: DeviceSortTextSchema,
    identification: DeviceSortTextSchema,
    provider: DeviceSortTextSchema,
    // browseOrderRows(key, 'film'), browse.ts, for each of the following
    genre: DeviceSortTextSchema,
    collection: DeviceSortTextSchema,
    playlist: DeviceSortTextSchema,
  })
  .catchall(DeviceSortTextSchema)

const DeviceFilmExtraSchema = z
  .object({
    // browseQueries, browse.ts: metadata->>'legacyHidden' = 'true'
    archived: z.boolean(),
    // browseQueries sourceKind, browse.ts: film.source_kind
    sourceKind: z.string().nullable(),
    // matchesValue('genre', 'film'), browse.ts: media_item_tag.tag_id, any hidden state
    tagIds: DeviceIdsSchema,
    // browseQueries creator scope, browse.ts: media_credit artist IDs by role
    creditIds: z
      .object({ director: DeviceIdsSchema, actor: DeviceIdsSchema })
      .strict(),
  })
  .strict()

export const DeviceFilmRowSchema = z
  .object({
    item: DeviceFilmItemSchema,
    text: DeviceFilmTextSchema,
    search: DeviceFilmSearchSchema,
    num: DeviceFilmNumberSchema,
    sort: DeviceFilmSortSchema,
    extra: DeviceFilmExtraSchema,
  })
  .strict()
export type DeviceFilmRow = z.infer<typeof DeviceFilmRowSchema>

// Artists

/** `listeningMonths` is rebuilt on the device from `artist_plays` and `meta` `listening`. */
export const DeviceArtistItemSchema = ArtistSummarySchema.omit({
  listeningScrobbles: true,
  listeningMonths: true,
  links: true,
})

const DeviceArtistTextSchema = z
  .object({
    // textRows('name'), artist-browse.ts
    name: DeviceTextSchema,
    // textMatchRows('playlist'), artist-browse.ts: visible playlists through artistPlaylistCredits
    playlist: DeviceTextSchema,
    // textRows('genre'), artist-browse.ts: raw snapshot tags; the filter matches `extra.rawTagKeys`
    genre: DeviceTextSchema,
    // textRows('country'), artist-browse.ts
    country: DeviceTextSchema,
    // textRows('type'), artist-browse.ts
    type: DeviceTextSchema,
    // textRows('provider'), artist-browse.ts
    provider: DeviceTextSchema,
  })
  .strict()

const DeviceArtistSearchSchema = z
  .object({
    // membership `q`, artist-browse.ts: the name and artist.sort_name
    name: DeviceTextSchema,
  })
  .strict()

/** Range values; albumCount and trackCount omit the in_library test the displayed counts use. */
const DeviceArtistNumberSchema = z
  .object({
    // numericValue('createdAt'), artist-browse.ts
    createdAt: DeviceNumberSchema,
    // numericValue('albumCount'), artist-browse.ts: candidates music_counts
    albumCount: DeviceNumberSchema,
    // numericValue('trackCount'), artist-browse.ts: candidates music_counts
    trackCount: DeviceNumberSchema,
    // numericValue('scrobbles'), artist-browse.ts: artist.scrobble_count
    scrobbles: DeviceNumberSchema,
    // numericValue('playlistCount'), artist-browse.ts: artistPlaylistCounts(), artist-library.ts
    playlistCount: DeviceNumberSchema,
  })
  .strict()

const DeviceArtistSortSchema = z
  .object({
    // ordering('name'), artist-browse.ts: lower(coalesce(sort_name, name))
    name: DeviceSortTextSchema,
    // candidates sort_values, artist-browse.ts: min(lower(value)) of textRows(key)
    playlist: DeviceSortTextSchema,
    genre: DeviceSortTextSchema,
    country: DeviceSortTextSchema,
    type: DeviceSortTextSchema,
    provider: DeviceSortTextSchema,
  })
  .strict()

const DeviceArtistExtraSchema = z
  .object({
    // textMatchRows('genre'), artist-browse.ts: normalizedTagSql of each raw snapshot tag
    rawTagKeys: DeviceTextSchema,
    // membership playlistIds, artist-browse.ts: visible playlists through artistPlaylistCredits
    playlistIds: DeviceIdsSchema,
  })
  .strict()

export const DeviceArtistRowSchema = z
  .object({
    item: DeviceArtistItemSchema,
    text: DeviceArtistTextSchema,
    search: DeviceArtistSearchSchema,
    num: DeviceArtistNumberSchema,
    sort: DeviceArtistSortSchema,
    extra: DeviceArtistExtraSchema,
  })
  .strict()
export type DeviceArtistRow = z.infer<typeof DeviceArtistRowSchema>

// Playlists

/**
 * The summary without `sync.job`, which is the `playlist_job` row named by
 * `extra.syncGroupKey`. `sync.nextScheduledAt` is the value playlistSync,
 * spotify-playlist-state.ts, gives with no job; the device sets it to null
 * when that job exists and has not succeeded.
 */
export const DevicePlaylistItemSchema = PlaylistSummarySchema.extend({
  sync: PlaylistSyncSchema.omit({ job: true }),
})

/** The directory has no text filters; `q` and `name` match `search`. */
const DevicePlaylistTextSchema = z.object({}).strict()

const DevicePlaylistSearchSchema = z
  .object({
    // playlistDirectoryFilter, playlist-directory.ts: p.name
    name: DeviceTextSchema,
    // playlistDirectoryFilter, playlist-directory.ts: p.owner_name
    owner: DeviceTextSchema,
    // playlistDirectoryFilter, playlist-directory.ts: p.description
    description: DeviceTextSchema,
  })
  .strict()

/** Sort-only numbers from playlistSortColumns, playlist-directory.ts. */
const DevicePlaylistNumberSchema = z
  .object({
    // playlistSortColumns.tracks: playlistTrackStats
    tracks: DeviceNumberSchema,
    // playlistSortColumns.linkedTracks: playlistTrackStats
    linkedTracks: DeviceNumberSchema,
    // playlistSortColumns.albums: playlistAlbumCount
    albums: DeviceNumberSchema,
    // playlistSortColumns.duration: playlistTrackStats
    duration: DeviceNumberSchema,
    // playlistSortColumns.imported: p.imported_at
    imported: DeviceNumberSchema,
    // playlistSortColumns.checked: coalesce(checked_at, imported_at)
    checked: DeviceNumberSchema,
    // playlistSortColumns.added: p.created_at
    added: DeviceNumberSchema,
  })
  .strict()

const DevicePlaylistSortSchema = z
  .object({
    // playlistSortColumns.name, playlist-directory.ts: lower(name); also the tie-break
    name: DeviceSortTextSchema,
    // playlistSortColumns.source, playlist-directory.ts: position of the source label
    source: DeviceNumberSchema,
    // playlistSortColumns.owner, playlist-directory.ts
    owner: DeviceSortTextSchema,
    // playlistSortColumns.description, playlist-directory.ts
    description: DeviceSortTextSchema,
    // playlistSortColumns.schedule, playlist-directory.ts
    schedule: DeviceNumberSchema,
    // playlistSortColumns.nextSync, playlist-directory.ts, with no job; null when the latest job has not succeeded
    nextSync: DeviceNumberSchema,
  })
  .strict()

const DevicePlaylistExtraSchema = z
  .object({
    // playlistDirectoryFilter sources, playlist-directory.ts: coalesce(source, 'library')
    source: z.enum(['library', 'spotify', 'spotify-liked']),
    // playlistGroup, playlist-directory.ts: the `playlist_job` ID; null when not syncable
    syncGroupKey: z.string().min(1).nullable(),
  })
  .strict()

export const DevicePlaylistRowSchema = z
  .object({
    item: DevicePlaylistItemSchema,
    text: DevicePlaylistTextSchema,
    search: DevicePlaylistSearchSchema,
    num: DevicePlaylistNumberSchema,
    sort: DevicePlaylistSortSchema,
    extra: DevicePlaylistExtraSchema,
  })
  .strict()
export type DevicePlaylistRow = z.infer<typeof DevicePlaylistRowSchema>

/**
 * latestSpotifyJobs(SPOTIFY_PLAYLIST_IMPORT_TASK), spotify-playlist-state.ts;
 * keyed by group key. While the job is queued or running the row carries its
 * status with `progress` and `activity` null, so progress writes do not
 * change it; the device does not serve a page that holds a playlist whose
 * job is in that state.
 */
export const DevicePlaylistJobRowSchema = SpotifyPlaylistJobSchema
export type DevicePlaylistJobRow = z.infer<typeof DevicePlaylistJobRowSchema>

// Shared rows

/**
 * One tag, keyed by tag ID. With `tag_key`, it lets the device resolve a
 * filter value as matchingTagNames, matchingTagIds and mediaIdsWithArtistTag
 * do, music-tags.ts.
 */
export const DeviceTagRowSchema = z
  .object({
    mediaType: z.enum(['album', 'film']),
    name: z.string(),
    // normalizedTagSql(t.name), lib/tag-sql.ts
    key: z.string(),
    kind: z.string(),
    hidden: z.boolean(),
    // tag_alias.target_tag_id where source_tag_id is this tag: canonicalTagRows, music-tags.ts
    aliasTargetId: z.string().min(1).nullable(),
    // tag_identity.normalized_name of the same media type pointing at this tag: canonicalTagRows
    identityKeys: DeviceTextSchema,
    // trackIdsWithTag inherits, music-tags.ts, and browse_track_sonovault_values,
    // browse.ts: a track_tag of this tag with in_browse and sonovault exists, on
    // any library_track, published or not
    sonovault: z.boolean(),
  })
  .strict()
export type DeviceTagRow = z.infer<typeof DeviceTagRowSchema>

/**
 * The stored hierarchy of one normalised name, keyed `<mediaType>:<key>`:
 * tag_ancestor.ancestor_key where descendant_key is the key, tag-hierarchy.ts.
 * A key is hidden when any tag row with that key is hidden (hiddenTagKey).
 */
export const DeviceTagKeyRowSchema = z
  .object({
    mediaType: z.enum(['album', 'film']),
    key: z.string(),
    ancestorKeys: DeviceTextSchema,
  })
  .strict()
export type DeviceTagKeyRow = z.infer<typeof DeviceTagKeyRowSchema>

/** Scrobble times as whole epoch seconds, ascending; `listened_at` is written from Last.fm's `uts`. */
const DevicePlaysSchema = z.array(z.number().int())

/** Every scrobble of one (username, artist_key, track_key), keyed by a hash of that key. */
export const DeviceScrobbleNameRowSchema = z
  .object({ plays: DevicePlaysSchema })
  .strict()

/** Scrobbles with lastfm_scrobble.album_media_item_id = the album: hasBrowseScrobbles('album'), browse-listening.ts. */
export const DeviceAlbumPlaysRowSchema = z
  .object({ plays: DevicePlaysSchema })
  .strict()

/** artistScrobbles, artist-browse.ts: each attributed scrobble once. */
export const DeviceArtistPlaysRowSchema = z
  .object({ plays: DevicePlaysSchema })
  .strict()

export const DeviceBrowseLibrarySchema = z.enum([
  'track',
  'album',
  'film',
  'artist',
])
export type DeviceBrowseLibrary = z.infer<typeof DeviceBrowseLibrarySchema>

/**
 * The database's case folding: each code point that `lower(chr(c))` changes,
 * with its result. A device folds text with this mapping and nothing else.
 */
export const DeviceFoldRowSchema = z
  .object({
    kind: z.literal('fold'),
    // foldMapping, device-rows/library.ts: every c from 1 to U+10FFFF outside
    // the surrogates with lower(chr(c)) <> chr(c), in ascending order
    codePoints: z.array(z.number().int().min(1).max(0x10ffff)),
    // lower(chr(c)) of each code point at the same index; a string, since a
    // database's lower() may yield more than one character
    lower: z.array(z.string().min(1)),
  })
  .strict()
  .refine(
    (row) =>
      row.codePoints.length === row.lower.length &&
      row.codePoints.every(
        (codePoint, index) =>
          index === 0 || codePoint > (row.codePoints[index - 1] ?? 0),
      ),
    'Each code point appears once, in ascending order, with one result.',
  )
export type DeviceFoldRow = z.infer<typeof DeviceFoldRowSchema>

/** Keyed `fields:<library>`, `listening`, `providers` and `fold`. */
export const DeviceMetaRowSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('fields'),
      library: DeviceBrowseLibrarySchema,
      // listBrowseFields(library), browse.ts; artistBrowseFields, packages/schemas/src/artist-browse.ts
      fields: z.array(BrowseFieldSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal('listening'),
      // listeningHistoryStart, listening-series.ts: YYYY-MM-DD, null without scrobbles
      historyStart: z.string().date().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('providers'),
      // providerDisplayNames(), provider-names.ts: facet labels and word matching
      names: z.array(
        z.object({ id: z.string().min(1), displayName: z.string() }).strict(),
      ),
    })
    .strict(),
  DeviceFoldRowSchema,
])
export type DeviceMetaRow = z.infer<typeof DeviceMetaRowSchema>

/** The payload schema of each entity. */
export const devicePayloadSchemas = {
  track: DeviceTrackRowSchema,
  album: DeviceAlbumRowSchema,
  film: DeviceFilmRowSchema,
  artist: DeviceArtistRowSchema,
  playlist: DevicePlaylistRowSchema,
  playlist_job: DevicePlaylistJobRowSchema,
  tag: DeviceTagRowSchema,
  tag_key: DeviceTagKeyRowSchema,
  scrobble_name: DeviceScrobbleNameRowSchema,
  album_plays: DeviceAlbumPlaysRowSchema,
  artist_plays: DeviceArtistPlaysRowSchema,
  meta: DeviceMetaRowSchema,
} satisfies Record<DeviceEntity, z.ZodType>

// Feed transport

const DeviceRowIdSchema = z.string().min(1).max(1000)

function liveRowSchema<Entity extends DeviceEntity, Payload extends z.ZodType>(
  entity: Entity,
  payload: Payload,
) {
  return z.object({
    entity: z.literal(entity),
    id: DeviceRowIdSchema,
    seq: DeviceSeqSchema,
    deleted: z.literal(false),
    payload,
  })
}

export const DeviceLiveRowSchema = z.discriminatedUnion('entity', [
  liveRowSchema('track', DeviceTrackRowSchema),
  liveRowSchema('album', DeviceAlbumRowSchema),
  liveRowSchema('film', DeviceFilmRowSchema),
  liveRowSchema('artist', DeviceArtistRowSchema),
  liveRowSchema('playlist', DevicePlaylistRowSchema),
  liveRowSchema('playlist_job', DevicePlaylistJobRowSchema),
  liveRowSchema('tag', DeviceTagRowSchema),
  liveRowSchema('tag_key', DeviceTagKeyRowSchema),
  liveRowSchema('scrobble_name', DeviceScrobbleNameRowSchema),
  liveRowSchema('album_plays', DeviceAlbumPlaysRowSchema),
  liveRowSchema('artist_plays', DeviceArtistPlaysRowSchema),
  liveRowSchema('meta', DeviceMetaRowSchema),
])
export type DeviceLiveRow = z.infer<typeof DeviceLiveRowSchema>

/** A row that left the feed: deleted, merged away or removed from the library. */
export const DeviceTombstoneSchema = z.object({
  entity: DeviceEntitySchema,
  id: DeviceRowIdSchema,
  seq: DeviceSeqSchema,
  deleted: z.literal(true),
  payload: z.null(),
})
export type DeviceTombstone = z.infer<typeof DeviceTombstoneSchema>

export const DeviceRowSchema = z.union([
  DeviceTombstoneSchema,
  DeviceLiveRowSchema,
])
export type DeviceRow = z.infer<typeof DeviceRowSchema>

/** `GET /api/v1/device/state`. */
export const DeviceFeedStateSchema = z.object({
  /** False until the first sweep has built the feed. */
  ready: z.boolean(),
  /** Changes when the feed is rebuilt from nothing. */
  epoch: z.string().min(1).max(100),
  /** The highest committed sequence number. */
  seq: DeviceSeqSchema,
  /** The oldest sequence from which tombstones are still held. */
  minSeq: DeviceSeqSchema,
  /** DEVICE_ROW_VERSION of the server. */
  rowVersion: z.number().int().positive(),
})
export type DeviceFeedState = z.infer<typeof DeviceFeedStateSchema>

export const DEVICE_PAGE_DEFAULT_ROWS = 500
export const DEVICE_PAGE_MAX_ROWS = 2000

const DeviceCursorParamSchema = z.coerce.number().int().nonnegative()
const DevicePageLimitParamSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(DEVICE_PAGE_MAX_ROWS)
  .default(DEVICE_PAGE_DEFAULT_ROWS)

/** `GET /api/v1/device/snapshot`: live rows of one entity after `after`, in `seq` order. */
export const DeviceSnapshotQuerySchema = z.object({
  epoch: DeviceFeedStateSchema.shape.epoch,
  entity: DeviceEntitySchema,
  after: DeviceCursorParamSchema.default(0),
  limit: DevicePageLimitParamSchema,
})
export type DeviceSnapshotQuery = z.infer<typeof DeviceSnapshotQuerySchema>

/** `GET /api/v1/device/changes`: rows and tombstones of every entity after `since`, in `seq` order. */
export const DeviceChangesQuerySchema = z.object({
  epoch: DeviceFeedStateSchema.shape.epoch,
  since: DeviceCursorParamSchema,
  limit: DevicePageLimitParamSchema,
})
export type DeviceChangesQuery = z.infer<typeof DeviceChangesQuerySchema>

/** Another epoch, or a `since` below `minSeq`: refill from a snapshot. */
export const DeviceResetSchema = z.object({ reset: z.literal(true) })

export const DeviceSnapshotPageSchema = z.object({
  reset: z.literal(false),
  rows: z.array(DeviceLiveRowSchema),
  /** The last `seq` in the page, or `after` when it is empty: the next `after`. */
  seq: DeviceSeqSchema,
  hasMore: z.boolean(),
})
export type DeviceSnapshotPage = z.infer<typeof DeviceSnapshotPageSchema>

export const DeviceChangesPageSchema = z.object({
  reset: z.literal(false),
  rows: z.array(DeviceRowSchema),
  /** The last `seq` in the page, or `since` when it is empty: the next `since`. */
  seq: DeviceSeqSchema,
  hasMore: z.boolean(),
  /** Dirty marks remain: rows not yet rendered can follow. */
  pending: z.boolean(),
})
export type DeviceChangesPage = z.infer<typeof DeviceChangesPageSchema>

export const DeviceSnapshotResponseSchema = z.discriminatedUnion('reset', [
  DeviceResetSchema,
  DeviceSnapshotPageSchema,
])
export type DeviceSnapshotResponse = z.infer<
  typeof DeviceSnapshotResponseSchema
>

export const DeviceChangesResponseSchema = z.discriminatedUnion('reset', [
  DeviceResetSchema,
  DeviceChangesPageSchema,
])
export type DeviceChangesResponse = z.infer<typeof DeviceChangesResponseSchema>
