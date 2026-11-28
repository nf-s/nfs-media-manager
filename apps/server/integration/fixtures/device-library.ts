import type pg from 'pg'

const at = (iso: string) => Date.parse(iso)

/**
 * An invented library: five artists, four albums (one archived, one an
 * edition), six tracks (two versions of one recording, one archived),
 * three films (one archived), two playlists and a collection.
 * Shared by the device row and device feed suites.
 */
export const deviceLibrarySql = `
  insert into artist (id, name, sort_name, scrobble_count) values
    ('artist-aster', 'Aster Vale', 'Vale, Aster', 3),
    ('artist-birch', 'birch Unit', null, 0),
    ('artist-cedar', 'Cedar Echo', null, 1),
    ('artist-delta', 'Delta Ray', null, 0),
    ('artist-echo', 'Echo Lin', null, 0);
  insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data) values
    ('snapshot-aster', 'artist-aster', 'musicbrainz', '{}',
      '{"tags": ["Ambient", "Drone"], "country": "NZ", "type": "Group"}'),
    ('snapshot-birch', 'artist-birch', 'lastfm', '{}',
      '{"tags": ["ambient", "Synth  Pop"], "country": "AU", "type": "Person"}');
  insert into artist_provider_current_state (artist_id, provider, latest_snapshot_id) values
    ('artist-aster', 'musicbrainz', 'snapshot-aster'),
    ('artist-birch', 'lastfm', 'snapshot-birch');

  insert into media_item (id, slug, media_type, title, release_date, source_label, metadata, created_at, updated_at) values
    ('album-north', 'album-north', 'album', 'Northern Lights', '2001-02-03', 'spotify',
      '{"browse": {"country": ["NZ"], "scrobbles": 12, "lastListenedAt": ${at('2024-05-06T07:08:09Z')}, "ratingRymValue": 3.9, "fixtureMood": "Blue", "fixtureScore": 7}}',
      '2020-01-01 00:00:00.123456', '2020-01-02'),
    ('album-quiet', 'album-quiet', 'album', 'quiet Fields', '1999-12-31', 'manual',
      '{"browse": {"country": "AU", "ratingRymValue": 4.2}}', '2020-01-03', '2020-01-03'),
    ('album-archive', 'album-archive', 'album', 'Archive Set', '2010-01-01', null,
      '{"legacyHidden": "true"}', '2020-01-04', '2020-01-04'),
    ('album-deluxe', 'album-deluxe', 'album', 'Northern Lights (Deluxe)', '2002-02-03', null,
      '{}', '2020-01-05', '2020-01-05'),
    ('track-aurora', 'track-aurora', 'track', 'Aurora', '2001-02-03', null, '{}', '2020-02-01', '2020-02-01'),
    ('track-aurora-live', 'track-aurora-live', 'track', 'Aurora', '2005-01-01', 'spotify', '{}', '2020-02-02', '2020-02-02'),
    ('track-bright', 'track-bright', 'track', 'Bright Water', null, null, '{}', '2020-02-03', '2020-02-03'),
    ('track-cold', 'track-cold', 'track', 'cold Stream', '2018-06-01', 'spotify-search',
      '{"spotifyTrackSearch": {}}', '2020-02-04', '2020-02-04'),
    ('track-delta', 'track-delta', 'track', 'Delta', null, null, '{"legacyHidden": "true"}', '2020-02-05', '2020-02-05'),
    ('track-echo', 'track-echo', 'track', 'Échelle', '2015-03-04', null, '{}', '2020-02-06', '2020-02-06'),
    ('film-harbor', 'film-harbor', 'film', 'Harbor', '1994-07-08', null,
      '{"browse": {"country": ["NZ", "AU"], "language": ["English"], "ratingImdbValue": 7.5}}', '2020-03-01', '2020-03-02'),
    ('film-iron', 'film-iron', 'film', 'Iron Gate', '1980-01-01', null, '{"legacyHidden": "true"}', '2020-03-03', '2020-03-03'),
    ('film-juniper', 'film-juniper', 'film', 'juniper', null, 'Plex', '{}', '2020-03-04', '2020-03-04');
  insert into album (media_item_id, edition_of_id, date_added, duration_sec, track_count) values
    ('album-north', null, '2021-01-01 10:00:00.654321', 2400, 10),
    ('album-quiet', null, '2021-02-01', null, 8),
    ('album-archive', null, '2021-03-01', 1800, 6),
    ('album-deluxe', 'album-north', '2021-04-01', 3000, 14);
  insert into film (media_item_id, date_added, runtime_minutes, watched, source_kind, budget) values
    ('film-harbor', '2022-01-01', 101, true, null, 1000000),
    ('film-iron', null, 90, false, null, null),
    ('film-juniper', null, null, false, 'plex', null);
  insert into library_track (media_item_id, album_media_item_id, album_name, spotify_track_id, spotify_album_id,
      isrc, duration_sec, date_added, scrobble_count, last_listened_at, version_shown) values
    ('track-aurora', 'album-north', null, null, null, 'ZZFIX2600001', 200, '2023-01-01 00:00:00.000001', 2, '2024-05-06', false),
    ('track-aurora-live', 'album-quiet', null, '4uLU6hMCjMI75M1A2tKUQC', null, 'ZZFIX2600001', 202, '2023-02-01', 1, '2024-05-07', false),
    ('track-bright', 'album-quiet', null, null, null, null, 240, '2023-03-01', 0, null, false),
    ('track-cold', null, 'Loose Single', '1uLU6hMCjMI75M1A2tKUQC', '2uLU6hMCjMI75M1A2tKUQC', null, 180, '2023-04-01', 0, null, false),
    ('track-delta', 'album-north', null, null, null, null, 120, '2023-05-01', 0, null, false),
    ('track-echo', null, null, null, null, null, null, '2023-06-01', 4, '2024-01-01', true);
  insert into track (id, album_media_item_id, track_media_item_id, title, position, duration_sec) values
    ('release-north-1', 'album-north', 'track-aurora', 'Aurora', 1, 200),
    ('release-north-2', 'album-north', 'track-delta', 'Delta', 2, 120),
    ('release-quiet-1', 'album-quiet', 'track-bright', 'Bright Water', 2, 240),
    ('release-quiet-2', 'album-quiet', 'track-aurora-live', 'Aurora', 1, 202),
    ('release-echo', 'album-north', 'track-echo', 'Échelle', 3, 300);
  insert into media_credit (media_item_id, artist_id, role, billing_order) values
    ('album-north', 'artist-aster', 'artist', 0),
    ('album-quiet', 'artist-birch', 'artist', 0),
    ('album-quiet', 'artist-aster', 'artist', 1),
    ('album-archive', 'artist-aster', 'artist', 0),
    ('album-deluxe', 'artist-aster', 'artist', 0),
    ('track-aurora', 'artist-aster', 'artist', 0),
    ('track-aurora-live', 'artist-aster', 'artist', 0),
    ('track-bright', 'artist-birch', 'artist', 0),
    ('track-cold', 'artist-birch', 'artist', 0),
    ('track-cold', 'artist-cedar', 'artist', 1),
    ('track-delta', 'artist-aster', 'artist', 0),
    ('track-echo', 'artist-cedar', 'artist', 0),
    ('film-harbor', 'artist-delta', 'director', 0),
    ('film-harbor', 'artist-echo', 'actor', 0),
    ('film-juniper', 'artist-echo', 'actor', 0);

  insert into tag (id, media_type, name, kind, hidden) values
    ('tag-ambient', 'album', 'Ambient', 'genre', false),
    ('tag-electronic', 'album', 'Electronic', 'genre', false),
    ('tag-electronica', 'album', 'Electronica', 'genre', false),
    ('tag-downtempo', 'album', 'Downtempo', 'genre', false),
    ('tag-synth', 'album', 'Synth Pop', 'genre', false),
    ('tag-pop', 'album', 'Pop', 'genre', false),
    ('tag-dream', 'album', 'Dream Pop', 'genre', false),
    ('tag-hidden', 'album', 'Hidden Noise', 'genre', true),
    ('tag-drama', 'film', 'Drama', 'genre', false),
    ('tag-noir', 'film', 'Noir', 'genre', false);
  insert into tag_alias (source_tag_id, target_tag_id) values ('tag-electronica', 'tag-electronic');
  insert into tag_identity (media_type, normalized_name, kind, tag_id) values
    ('album', 'electronic music', 'genre', 'tag-electronic'),
    ('album', 'electronic music', 'style', 'tag-electronic');
  insert into tag_parent (media_type, child_key, parent_key) values
    ('album', 'dream pop', 'pop'), ('album', 'synth pop', 'pop'), ('film', 'noir', 'drama');
  insert into tag_ancestor (media_type, descendant_key, ancestor_key) values
    ('album', 'dream pop', 'pop'), ('album', 'synth pop', 'pop'), ('film', 'noir', 'drama');
  insert into media_item_tag (media_item_id, tag_id) values
    ('album-north', 'tag-ambient'), ('album-north', 'tag-electronic'), ('album-north', 'tag-downtempo'),
    ('album-north', 'tag-hidden'), ('album-quiet', 'tag-synth'), ('album-archive', 'tag-ambient'),
    ('film-harbor', 'tag-drama'), ('film-harbor', 'tag-noir');
  insert into track_tag (media_item_id, tag_id, owner, sonovault, verified) values
    ('track-bright', 'tag-dream', 'added', false, false),
    ('track-echo', 'tag-pop', null, true, true),
    ('track-echo', 'tag-hidden', 'added', false, false);
  insert into track_fact (media_item_id, provider, bpm, key_camelot, verified, fetched_at) values
    ('track-echo', 'sonovault', 120, '8A', true, '2024-01-01'),
    ('track-bright', 'sonovault', 96.5, '11B', true, '2024-01-01');

  insert into playlist (id, name, kind, added_to_library, source, spotify_id, owner_name, description,
      imported_at, checked_at, sync_schedule, created_at) values
    ('playlist-morning', 'Morning Mix', 'playlist', true, null, null, null, 'Early tracks', null, null, 'off', '2022-05-01'),
    ('playlist-picks', 'Spotify Picks', 'playlist', false, 'spotify', 'fixturePlaylistId0001', 'Fixture Owner', null,
      '2022-06-01', '2022-06-02 03:04:05.678901', 'daily', '2022-06-01'),
    ('collection-films', 'Film Picks', 'collection', true, null, null, null, null, null, null, 'off', '2022-07-01');
  insert into playlist_item (playlist_id, media_item_id, position) values
    ('playlist-morning', 'track-aurora', 0), ('playlist-morning', 'track-bright', 1),
    ('playlist-morning', 'album-quiet', 2), ('playlist-picks', 'track-cold', 0),
    ('playlist-picks', 'track-aurora-live', 1), ('collection-films', 'film-harbor', 0);

  insert into provider_reference (id, media_item_id, provider, reference_type, external_id) values
    ('reference-bright', 'track-bright', 'musicbrainz', 'musicbrainz-recording', '1'),
    ('reference-isrc', 'track-aurora', 'musicbrainz', 'isrc', 'ZZFIX2600001'),
    ('reference-north', 'album-north', 'discogs', 'discogs-release', '2'),
    ('reference-harbor', 'film-harbor', 'imdb', 'imdb', 'tt0000001');

  insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key, album_media_item_id) values
    ('scrobble-1', 'fixture-listener', '2024-05-01 10:00:00', 'Aster Vale', 'Aurora', 'aster vale', 'aurora', 'album-north'),
    ('scrobble-2', 'fixture-listener', '2024-05-06 00:00:00', 'Aster Vale', 'Aurora', 'aster vale', 'aurora', 'album-north'),
    ('scrobble-3', 'fixture-listener', '2024-05-07 00:00:00', 'Aster Vale', 'Aurora', 'aster vale', 'aurora', null),
    ('scrobble-4', 'fixture-listener', '2024-01-01 00:00:00', 'Cedar Echo', 'Echelle', 'cedar echo', 'echelle', null);
  insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy) values
    ('fixture-listener', 'aster vale', 'aurora', 'track-aurora', 'exact'),
    ('fixture-listener', 'aster vale', 'aurora', 'track-aurora-live', 'exact'),
    ('fixture-listener', 'cedar echo', 'echelle', 'track-echo', 'normalized');

  insert into scrape_job (id, provider, status, scope, options) values
    ('job-picks', 'spotify', 'running', '{}', '{"task": "spotify-playlist-import", "groupKey": "spotify:fixturePlaylistId0001",
      "progress": {"pagesRead": 1, "totalPages": 3}}'),
    ('job-liked', 'spotify', 'failed', '{}', '{"task": "spotify-playlist-import", "groupKey": "spotify-liked"}');
`

export async function seedDeviceLibrary(pool: pg.Pool) {
  await pool.query(deviceLibrarySql)
}
