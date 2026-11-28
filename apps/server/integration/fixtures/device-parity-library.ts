import type pg from 'pg'
import { deviceLibrarySql } from './device-library'

/**
 * The parity suite's library (docs/requirements/device-store.md, DEVICE-32):
 * the device library plus rows that reach every Browse field, every grouping
 * rule and the edges of the listening periods around `PARITY_NOW`. Invented
 * names and identifiers only.
 */

/** The one clock of the suite, on the API and on the device. */
export const PARITY_NOW = new Date('2026-03-31T12:00:00.000Z')

export const parityLibrarySql = `
  insert into artist (id, name, sort_name, scrobble_count, added_to_library, created_at) values
    ('artist-fern', 'Fern Ålund', 'Ålund, Fern', 0, true, '2021-05-05 05:05:05'),
    ('artist-gale', 'gale', null, 0, false, '2021-05-05 05:05:05'),
    ('artist-hollow', 'İris Hollow', null, 0, false, '2022-01-01'),
    ('artist-ivy', 'Ivy Lane', null, 0, false, '2022-01-02'),
    ('artist-ivy-caps', 'IVY LANE', null, 0, false, '2022-01-03'),
    ('artist-jade', 'Jade Ōta', null, 0, false, '2022-01-04'),
    ('artist-kite', 'Kite', null, 0, false, '2022-01-05'),
    ('artist-lumen', 'Lumen', null, 0, false, '2022-01-06'),
    ('artist-mire', 'Mire', null, 0, true, '2022-01-07'),
    ('artist-outside', 'Outside Artist', null, 0, false, '2022-01-08'),
    ('artist-cafe', 'Café Noir', null, 0, false, '2022-01-09'),
    ('artist-cafe-nfd', 'Cafe\u0301 Noir', null, 0, false, '2022-01-09');
  insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data) values
    ('snapshot-fern', 'artist-fern', 'musicbrainz', '{}',
      '{"tags": ["Ambient", "Post-Rock"], "country": "SE", "type": "Person"}'),
    ('snapshot-kite', 'artist-kite', 'lastfm', '{}',
      '{"tags": ["Shoegaze", "dream pop"], "country": "GB", "type": "Group"}'),
    ('snapshot-lumen', 'artist-lumen', 'musicbrainz', '{}',
      '{"tags": ["Glitch"], "country": "nz", "type": "Group"}'),
    ('snapshot-hollow', 'artist-hollow', 'lastfm', '{}',
      '{"tags": ["İndie"], "country": "TR"}');
  insert into artist_provider_current_state (artist_id, provider, latest_snapshot_id) values
    ('artist-fern', 'musicbrainz', 'snapshot-fern'),
    ('artist-kite', 'lastfm', 'snapshot-kite'),
    ('artist-lumen', 'musicbrainz', 'snapshot-lumen'),
    ('artist-hollow', 'lastfm', 'snapshot-hollow');

  insert into media_item (id, slug, media_type, title, summary, release_date, source_label, in_library, metadata, created_at, updated_at) values
    ('album-orbit', 'album-orbit', 'album', 'Orbit', null, '2001-02-03', 'spotify', true,
      '{"browse": {"country": ["SE", "NZ"], "ratingRymValue": 3.9, "ratingRymVotes": 40, "popularitySpotify": 20, "fixtureMood": "blue", "fixtureScore": 7.5, "fixtureCode": 12, "language": ["Swedish"], "danceability": 0.5}}',
      '2020-01-06', '2020-01-06'),
    ('album-orbit-live', 'album-orbit-live', 'album', 'Orbit (Live)', null, '2003-03-03', null, true,
      '{"browse": {"fixtureMood": "Grey"}}', '2020-01-07', '2020-01-07'),
    ('album-pulse', 'album-pulse', 'album', 'pulse', null, null, 'manual', true,
      '{"browse": {"ratingRymValue": 2.25, "fixtureMood": ["Red", "blue"], "fixtureCode": "B7"}}', '2020-01-08', '2020-01-08'),
    ('album-ridge', 'album-ridge', 'album', 'Ridge', null, '1999-12-31', 'spotify', true,
      '{"browse": {"country": "GB", "popularitySpotify": 20, "fixtureScore": 2}}', '2020-01-09', '2020-01-09'),
    ('album-vault', 'album-vault', 'album', 'Vault', null, '2011-11-11', null, true,
      '{"legacyHidden": "true", "browse": {"country": "NZ"}}', '2020-01-10', '2020-01-10'),
    ('album-outside', 'album-outside', 'album', 'Outside Album', null, '2012-01-01', null, false,
      '{}', '2020-01-11', '2020-01-11'),
    ('track-orbit-a', 'track-orbit-a', 'track', 'Orbit Song', null, '2001-02-03', 'spotify', true, '{}', '2020-04-01', '2020-04-01'),
    ('track-orbit-b', 'track-orbit-b', 'track', 'Orbit Song', null, '2003-03-03', null, true, '{}', '2020-04-02', '2020-04-02'),
    ('track-hum-a', 'track-hum-a', 'track', 'Hum', null, null, 'spotify', true, '{}', '2020-04-03', '2020-04-03'),
    ('track-hum-b', 'track-hum-b', 'track', 'HUM', null, '2001-01-01', null, true, '{}', '2020-04-04', '2020-04-04'),
    ('track-hum-lastfm', 'track-hum-lastfm', 'track', 'Hum', null, null, 'lastfm', true, '{}', '2020-04-05', '2020-04-05'),
    ('track-lone-lastfm', 'track-lone-lastfm', 'track', 'Lone Signal', null, null, 'lastfm', true, '{}', '2020-04-06', '2020-04-06'),
    ('track-drift-a', 'track-drift-a', 'track', 'Drift', null, '1999-12-31', 'spotify', true, '{}', '2020-04-07', '2020-04-07'),
    ('track-drift-b', 'track-drift-b', 'track', 'Drift (Live)', null, '2000-06-01', null, true, '{}', '2020-04-08', '2020-04-08'),
    ('track-drift-c', 'track-drift-c', 'track', 'Drift', null, '2000-01-01', null, true, '{}', '2020-04-09', '2020-04-09'),
    ('track-drift-d', 'track-drift-d', 'track', 'drift', null, null, null, true, '{}', '2020-04-10', '2020-04-10'),
    ('track-istanbul', 'track-istanbul', 'track', 'İstanbul Night', null, '2010-10-10', null, true, '{}', '2020-04-11', '2020-04-11'),
    ('track-echelle', 'track-echelle', 'track', 'Echelle', null, '2015-03-04', null, true, '{}', '2020-04-12', '2020-04-12'),
    ('track-echelle-caps', 'track-echelle-caps', 'track', 'ECHELLE', null, null, null, true, '{}', '2020-04-13', '2020-04-13'),
    ('track-cold-jade', 'track-cold-jade', 'track', 'Cold Stream', null, '2018-06-01', null, true, '{}', '2020-04-14', '2020-04-14'),
    ('track-liked', 'track-liked', 'track', 'Liked One', null, '2020-02-02', 'spotify-liked', true, '{}', '2020-04-15', '2020-04-15'),
    ('track-glitch', 'track-glitch', 'track', 'glitch', null, '2011-11-11', null, true, '{}', '2020-04-16', '2020-04-16'),
    ('track-vault', 'track-vault', 'track', 'Vault Theme', null, '2011-11-11', null, true, '{}', '2020-04-17', '2020-04-17'),
    ('track-outside', 'track-outside', 'track', 'Outside Song', null, null, null, false, '{}', '2020-04-18', '2020-04-18'),
    ('track-mire', 'track-mire', 'track', '_mire 100%', null, '2024-12-31', null, true, '{}', '2020-04-19', '2020-04-19'),
    ('track-cafe', 'track-cafe', 'track', 'Café', null, '2019-01-01', null, true, '{}', '2020-04-20', '2020-04-20'),
    ('track-cafe-nfd', 'track-cafe-nfd', 'track', 'Cafe\u0301', null, '2019-01-01', null, true, '{}', '2020-04-20', '2020-04-20'),
    ('film-kestrel', 'film-kestrel', 'film', 'Kestrel', 'A falcon over the harbour.', '1994-07-08', null, true,
      '{"browse": {"country": ["GB"], "language": ["English", "Welsh"], "productionCompany": ["North Pictures"], "ratingImdbValue": 7.5, "ratingImdbVotes": 1000, "fixtureMood": "Dark", "fixtureCode": 9}}',
      '2020-05-01', '2020-05-02'),
    ('film-lagoon', 'film-lagoon', 'film', 'lagoon', null, null, 'Plex', true,
      '{"browse": {"language": "english", "ratingImdbValue": 6.25, "awards": "Two wins", "fixtureCode": "alpha"}}', '2020-05-03', '2020-05-03'),
    ('film-moth', 'film-moth', 'film', 'Moth', null, '2001-01-01', null, true,
      '{"legacyHidden": "true", "browse": {"country": "NZ"}}', '2020-05-04', '2020-05-04'),
    ('film-outside', 'film-outside', 'film', 'Outside Film', null, '2002-02-02', null, false, '{}', '2020-05-05', '2020-05-05');
  insert into album (media_item_id, edition_of_id, date_added, duration_sec, track_count) values
    ('album-orbit', null, '2021-01-01 10:00:00.654321', 2400, 3),
    ('album-orbit-live', 'album-orbit', '2021-04-02', 2500, 4),
    ('album-pulse', null, '2021-02-01', null, 0),
    ('album-ridge', null, null, 1500, 2),
    ('album-vault', null, '2021-05-01', 1000, 1),
    ('album-outside', null, '2021-06-01', 900, 1);
  insert into film (media_item_id, date_added, runtime_minutes, watched, source_kind, budget, box_office) values
    ('film-kestrel', '2022-01-01', 101, true, 'plex', 2000000, 5000000),
    ('film-lagoon', null, 88, false, 'plex', null, null),
    ('film-moth', '2022-03-03', 70, false, null, null, null),
    ('film-outside', null, 95, false, null, null, null);
  insert into library_track (media_item_id, album_media_item_id, album_name, spotify_track_id, spotify_album_id,
      isrc, duration_sec, date_added, scrobble_count, last_listened_at, version_group_id, version_shown) values
    ('track-orbit-a', 'album-orbit', null, '5uLU6hMCjMI75M1A2tKUQC', null, 'ZZFIX2600002', 300, '2023-01-01 00:00:00.000001', 0, null, null, false),
    ('track-orbit-b', 'album-orbit-live', null, null, null, 'zzfix2600002 ', 310, '2023-07-01', 0, null, null, false),
    ('track-hum-a', null, 'Hum Single', '6uLU6hMCjMI75M1A2tKUQC', null, null, 180, '2023-07-01', 0, null, null, false),
    ('track-hum-b', 'album-pulse', null, null, null, null, null, '2023-07-02', 0, null, null, false),
    ('track-hum-lastfm', null, null, null, null, null, 181, '2023-07-03', 0, null, null, false),
    ('track-lone-lastfm', null, null, null, null, null, null, '2023-07-03', 0, null, null, false),
    ('track-drift-a', 'album-ridge', null, '7uLU6hMCjMI75M1A2tKUQC', null, 'ZZFIX2600003', 240, '2023-08-01', 0, null, 'version-drift', true),
    ('track-drift-b', 'album-ridge', null, null, null, null, 260, '2023-08-02', 0, null, 'version-drift', false),
    ('track-drift-c', null, 'Drift EP', '8uLU6hMCjMI75M1A2tKUQC', null, 'ZZFIX2600003', 241, '2023-08-03', 0, null, null, false),
    ('track-drift-d', null, 'Drift EP', '9uLU6hMCjMI75M1A2tKUQC', null, 'ZZFIX2600003', 243, '2023-08-03', 0, null, null, false),
    ('track-istanbul', null, null, null, null, null, 199, '2023-09-01', 0, null, null, false),
    ('track-echelle', null, null, null, null, null, 300, '2023-06-01', 0, null, null, false),
    ('track-echelle-caps', null, null, null, null, null, 301, null, 0, null, null, false),
    ('track-cold-jade', null, 'Loose Single', null, null, null, 180, '2023-04-01', 0, null, null, false),
    ('track-liked', null, null, 'auLU6hMCjMI75M1A2tKUQC', null, null, 150, '2023-10-01', 0, null, null, false),
    ('track-glitch', 'album-vault', null, null, null, null, 95, '2023-10-02', 0, null, null, false),
    ('track-vault', 'album-vault', null, null, null, null, 120, '2023-10-03', 0, null, null, false),
    ('track-outside', null, null, null, null, null, 100, '2023-10-04', 0, null, null, false),
    ('track-mire', null, null, null, null, null, 210, '2023-10-05', 0, null, null, false),
    ('track-cafe', null, null, null, null, null, 200, '2023-10-06', 0, null, null, false),
    ('track-cafe-nfd', null, null, null, null, null, 200, '2023-10-06', 0, null, null, false);
  insert into track (id, album_media_item_id, track_media_item_id, title, position, duration_sec) values
    ('release-orbit-1', 'album-orbit', 'track-orbit-a', 'Orbit Song', 1, 300),
    ('release-orbit-live-1', 'album-orbit-live', 'track-orbit-b', 'Orbit Song', 1, 310),
    ('release-pulse-1', 'album-pulse', 'track-hum-b', 'HUM', 1, 179),
    ('release-ridge-1', 'album-ridge', 'track-drift-a', 'Drift', 1, 240),
    ('release-ridge-2', 'album-ridge', 'track-drift-b', 'Drift (Live)', 2, 260),
    ('release-vault-1', 'album-vault', 'track-glitch', 'glitch', 1, 95),
    ('release-vault-2', 'album-vault', 'track-vault', 'Vault Theme', 2, 120);
  insert into media_credit (media_item_id, artist_id, role, billing_order) values
    ('album-orbit', 'artist-fern', 'artist', 0),
    ('album-orbit-live', 'artist-fern', 'artist', 0),
    ('album-pulse', 'artist-gale', 'artist', 0),
    ('album-ridge', 'artist-kite', 'artist', 0),
    ('album-vault', 'artist-lumen', 'artist', 0),
    ('album-outside', 'artist-outside', 'artist', 0),
    ('track-orbit-a', 'artist-fern', 'artist', 0),
    ('track-orbit-b', 'artist-fern', 'artist', 0),
    ('track-hum-a', 'artist-gale', 'artist', 0),
    ('track-hum-b', 'artist-gale', 'artist', 0),
    ('track-hum-lastfm', 'artist-gale', 'artist', 0),
    ('track-lone-lastfm', 'artist-mire', 'artist', 0),
    ('track-drift-a', 'artist-kite', 'artist', 0),
    ('track-drift-b', 'artist-kite', 'artist', 0),
    ('track-drift-c', 'artist-kite', 'artist', 0),
    ('track-drift-d', 'artist-kite', 'artist', 0),
    ('track-istanbul', 'artist-hollow', 'artist', 0),
    ('track-echelle', 'artist-cedar', 'artist', 0),
    ('track-echelle-caps', 'artist-ivy-caps', 'artist', 0),
    ('track-cold-jade', 'artist-jade', 'artist', 0),
    ('track-liked', 'artist-ivy', 'artist', 0),
    ('track-liked', 'artist-ivy-caps', 'artist', 1),
    ('track-glitch', 'artist-lumen', 'artist', 0),
    ('track-vault', 'artist-lumen', 'artist', 0),
    ('track-outside', 'artist-outside', 'artist', 0),
    ('track-mire', 'artist-mire', 'artist', 0),
    ('track-cafe', 'artist-cafe', 'artist', 0),
    ('track-cafe-nfd', 'artist-cafe-nfd', 'artist', 0),
    ('film-kestrel', 'artist-delta', 'director', 0),
    ('film-kestrel', 'artist-jade', 'writer', 0),
    ('film-kestrel', 'artist-echo', 'actor', 0),
    ('film-kestrel', 'artist-hollow', 'actor', 1),
    ('film-lagoon', 'artist-jade', 'director', 0),
    ('film-moth', 'artist-delta', 'director', 0),
    ('film-outside', 'artist-delta', 'director', 0);

  insert into tag (id, media_type, name, kind, hidden) values
    ('tag-indie', 'album', 'Indie', 'genre', false),
    ('tag-rock', 'album', 'Rock', 'genre', false),
    ('tag-shoegaze', 'album', 'Shoegaze', 'genre', false),
    ('tag-noise-pop', 'album', 'Noise Pop', 'genre', false),
    ('tag-post-rock', 'album', 'Post-Rock', 'style', false),
    ('tag-glitch', 'album', 'Glitch', 'genre', false),
    ('tag-turkish', 'album', 'İndie', 'genre', false),
    ('tag-ambient-caps', 'album', 'AMBIENT', 'style', false),
    ('tag-secret', 'album', 'Secret Scene', 'genre', true),
    ('tag-thriller', 'film', 'Thriller', 'genre', false),
    ('tag-film-hidden', 'film', 'Hidden Film', 'genre', true),
    ('tag-neo-noir', 'film', 'Neo-Noir', 'genre', false);
  insert into tag_alias (source_tag_id, target_tag_id) values ('tag-ambient-caps', 'tag-ambient');
  insert into tag_parent (media_type, child_key, parent_key) values
    ('album', 'dream pop', 'indie'), ('album', 'indie', 'rock'), ('album', 'shoegaze', 'rock'),
    ('album', 'noise pop', 'hidden noise'), ('album', 'post-rock', 'rock'), ('album', 'glitch', 'secret scene'),
    ('film', 'neo-noir', 'noir');
  insert into tag_ancestor (media_type, descendant_key, ancestor_key) values
    ('album', 'dream pop', 'indie'), ('album', 'dream pop', 'rock'), ('album', 'indie', 'rock'),
    ('album', 'shoegaze', 'rock'), ('album', 'noise pop', 'hidden noise'), ('album', 'post-rock', 'rock'),
    ('album', 'glitch', 'secret scene'),
    ('film', 'neo-noir', 'noir'), ('film', 'neo-noir', 'drama');
  insert into media_item_tag (media_item_id, tag_id) values
    ('album-orbit', 'tag-dream'), ('album-orbit', 'tag-electronica'), ('album-orbit', 'tag-ambient-caps'),
    ('album-orbit-live', 'tag-dream'), ('album-ridge', 'tag-shoegaze'), ('album-vault', 'tag-glitch'),
    ('album-vault', 'tag-noise-pop'), ('album-outside', 'tag-rock'),
    ('film-kestrel', 'tag-neo-noir'), ('film-kestrel', 'tag-thriller'), ('film-kestrel', 'tag-film-hidden'),
    ('film-lagoon', 'tag-drama'), ('film-moth', 'tag-noir'), ('film-outside', 'tag-thriller');
  insert into track_tag (media_item_id, tag_id, owner, sonovault, verified) values
    ('track-orbit-a', 'tag-shoegaze', 'added', false, false),
    ('track-orbit-a', 'tag-ambient-caps', 'added', false, false),
    ('track-hum-a', 'tag-noise-pop', null, true, true),
    ('track-hum-b', 'tag-indie', null, true, false),
    ('track-drift-c', 'tag-post-rock', 'added', true, true),
    ('track-drift-d', 'tag-pop', 'removed', true, true),
    ('track-istanbul', 'tag-turkish', 'added', false, false),
    ('track-glitch', 'tag-secret', 'added', false, false),
    ('track-outside', 'tag-shoegaze', null, true, true),
    ('track-outside', 'tag-rock', null, true, true);
  insert into track_fact (media_item_id, provider, bpm, key_camelot, verified, fetched_at) values
    ('track-orbit-a', 'sonovault', 120, '8A', true, '2024-01-01'),
    ('track-orbit-b', 'sonovault', 120.25, '8B', true, '2024-01-01'),
    ('track-hum-a', 'sonovault', 96.5, '11B', true, '2024-01-01'),
    ('track-drift-a', 'sonovault', 0.5, '1A', true, '2024-01-01'),
    ('track-drift-c', 'sonovault', null, null, true, '2024-01-01'),
    ('track-istanbul', 'sonovault', 133.75, '12A', false, '2024-01-01');

  insert into playlist (id, name, kind, added_to_library, source, spotify_id, owner_name, description,
      imported_at, checked_at, sync_schedule, spotify_editable, created_at) values
    ('playlist-liked', 'Liked Songs', 'playlist', false, 'spotify-liked', null, null, null,
      '2022-08-01', '2026-03-30 10:00:00', 'daily', true, '2022-08-01'),
    ('playlist-weekly', 'weekly finds', 'playlist', false, 'spotify', 'fixturePlaylistId0002', 'another owner', 'Found Weekly',
      '2022-09-01', '2026-03-28 00:00:00', 'weekly', false, '2022-09-01'),
    ('playlist-hourly', 'Hourly Picks', 'playlist', false, 'spotify', 'fixturePlaylistId0003', 'Fixture Owner', 'picks',
      '2022-10-01', null, '1h', true, '2022-10-01'),
    ('playlist-queued', 'Queued Mix', 'playlist', false, 'spotify', 'fixturePlaylistId0004', null, null,
      null, null, '6h', true, '2022-11-01'),
    ('playlist-empty', 'Ëmpty', 'playlist', true, null, null, null, 'nothing yet', null, null, 'off', true, '2022-12-01'),
    ('collection-classics', 'Classics', 'collection', true, null, null, null, null, null, null, 'off', true, '2022-12-02');
  insert into playlist_item (playlist_id, media_item_id, position) values
    ('playlist-liked', 'track-liked', 0), ('playlist-liked', 'track-hum-a', 1),
    ('playlist-weekly', 'track-orbit-a', 0), ('playlist-weekly', 'track-drift-a', 1), ('playlist-weekly', 'album-orbit', 2),
    ('playlist-hourly', 'track-hum-a', 0), ('playlist-hourly', 'track-lone-lastfm', 1),
    ('playlist-queued', 'track-istanbul', 0),
    ('playlist-morning', 'track-orbit-a', 3), ('playlist-morning', 'album-ridge', 4),
    ('collection-classics', 'film-kestrel', 0), ('collection-films', 'film-lagoon', 1);

  insert into provider_reference (id, media_item_id, provider, reference_type, external_id) values
    ('reference-orbit', 'album-orbit', 'discogs', 'discogs-release', '3'),
    ('reference-orbit-mb', 'album-orbit', 'musicbrainz', 'musicbrainz-release', '4'),
    ('reference-hum', 'track-hum-a', 'musicbrainz', 'musicbrainz-recording', '5'),
    ('reference-drift', 'track-drift-a', 'discogs', 'discogs-track', '6'),
    ('reference-kestrel', 'film-kestrel', 'tmdb', 'tmdb', '42'),
    ('reference-lagoon', 'film-lagoon', 'imdb', 'imdb', 'not-an-id');

  insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key, album_media_item_id) values
    ('scrobble-now', 'fixture-listener', '2026-03-31 12:00:00', 'Fern Ålund', 'Orbit Song', 'fern ålund', 'orbit song', 'album-orbit'),
    ('scrobble-future', 'fixture-listener', '2026-03-31 12:00:01', 'Fern Ålund', 'Orbit Song', 'fern ålund', 'orbit song', 'album-orbit'),
    ('scrobble-year-edge', 'fixture-listener', '2025-03-31 12:00:00', 'Fern Ålund', 'Orbit Song', 'fern ålund', 'orbit song', null),
    ('scrobble-year-before', 'fixture-listener', '2025-03-31 11:59:59', 'Fern Ålund', 'Orbit Song', 'fern ålund', 'orbit song', null),
    ('scrobble-month-edge', 'fixture-listener', '2026-02-28 12:00:00', 'gale', 'hum', 'gale', 'hum', 'album-pulse'),
    ('scrobble-month-before', 'fixture-listener', '2026-02-28 11:59:59', 'gale', 'hum', 'gale', 'hum', 'album-pulse'),
    ('scrobble-new-year', 'fixture-listener', '2026-01-01 00:00:00', 'gale', 'hum', 'gale', 'hum', null),
    ('scrobble-old-year', 'fixture-listener', '2025-12-31 23:59:59', 'gale', 'hum', 'gale', 'hum', null),
    ('scrobble-month-start', 'fixture-listener', '2026-02-01 00:00:00', 'Kite', 'Drift', 'kite', 'drift', 'album-ridge'),
    ('scrobble-month-end', 'fixture-listener', '2026-01-31 23:59:59', 'Kite', 'Drift', 'kite', 'drift', 'album-ridge'),
    ('scrobble-same-1', 'fixture-listener', '2026-03-24 12:00:00', 'Kite', 'Drift', 'kite', 'drift', null),
    ('scrobble-same-2', 'fixture-listener', '2026-03-24 12:00:00', 'Kite', 'Drift', 'kite', 'drift', null),
    ('scrobble-same-3', 'fixture-listener', '2026-03-24 12:00:00', 'İris Hollow', 'İstanbul Night', 'i̇ris hollow', 'i̇stanbul night', null),
    ('scrobble-week-edge', 'fixture-listener', '2026-03-24 11:59:59', 'Lumen', 'glitch', 'lumen', 'glitch', 'album-vault'),
    ('scrobble-2019', 'fixture-listener', '2019-06-15 08:00:00', 'Lumen', 'glitch', 'lumen', 'glitch', 'album-vault'),
    ('scrobble-2021', 'fixture-listener', '2021-02-28 23:59:59', 'Jade Ōta', 'Cold Stream', 'jade ōta', 'cold stream', null),
    ('scrobble-2023', 'fixture-listener', '2023-12-31 23:59:59', 'Ivy Lane', 'Liked One', 'ivy lane', 'liked one', null),
    ('scrobble-other-listener', 'second-listener', '2026-03-01 00:00:00', 'gale', 'hum', 'gale', 'hum', null),
    ('scrobble-unlinked', 'fixture-listener', '2026-03-02 00:00:00', 'Nobody', 'Nothing', 'nobody', 'nothing', null);
  insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy) values
    ('fixture-listener', 'fern ålund', 'orbit song', 'track-orbit-a', 'exact'),
    ('fixture-listener', 'fern ålund', 'orbit song', 'track-orbit-b', 'exact'),
    ('fixture-listener', 'gale', 'hum', 'track-hum-a', 'exact'),
    ('fixture-listener', 'gale', 'hum', 'track-hum-b', 'exact'),
    ('second-listener', 'gale', 'hum', 'track-hum-a', 'exact'),
    ('fixture-listener', 'kite', 'drift', 'track-drift-a', 'exact'),
    ('fixture-listener', 'kite', 'drift', 'track-drift-c', 'normalized'),
    ('fixture-listener', 'i̇ris hollow', 'i̇stanbul night', 'track-istanbul', 'exact'),
    ('fixture-listener', 'lumen', 'glitch', 'track-glitch', 'exact'),
    ('fixture-listener', 'jade ōta', 'cold stream', 'track-cold-jade', 'exact'),
    ('fixture-listener', 'ivy lane', 'liked one', 'track-liked', 'exact');
  insert into lastfm_track_source (username, artist_key, track_key, manually_matched, track_media_item_id) values
    ('fixture-listener', 'gale', 'hum', false, 'track-hum-lastfm'),
    ('fixture-listener', 'mire', 'lone signal', false, 'track-lone-lastfm');

  insert into scrape_job (id, provider, status, scope, options, created_at) values
    ('job-weekly-old', 'spotify', 'failed', '{}', '{"task": "spotify-playlist-import", "groupKey": "spotify:fixturePlaylistId0002"}', '2026-01-01'),
    ('job-weekly', 'spotify', 'succeeded', '{}', '{"task": "spotify-playlist-import", "groupKey": "spotify:fixturePlaylistId0002"}', '2026-03-28'),
    ('job-hourly', 'spotify', 'cancelled', '{}', '{"task": "spotify-playlist-import", "groupKey": "spotify:fixturePlaylistId0003"}', '2026-03-29'),
    ('job-queued', 'spotify', 'queued', '{}', '{"task": "spotify-playlist-import", "groupKey": "spotify:fixturePlaylistId0004"}', '2026-03-30');
`

/** The device library and the parity additions, in one statement. */
export async function seedParityLibrary(pool: pg.Pool) {
  await pool.query(deviceLibrarySql)
  await pool.query(parityLibrarySql)
}

/**
 * The plugin fields the suite declares for Albums and Films: text, number
 * and a text field holding numbers, a key built in to both libraries
 * (country), one built in to Films only (language) and a Spotify audio
 * feature (danceability).
 */
export const parityPluginFields = [
  { key: 'fixtureMood', label: 'Fixture mood', type: 'text' },
  { key: 'fixtureScore', label: 'Fixture score', type: 'number' },
  { key: 'fixtureCode', label: 'Fixture code', type: 'text' },
  { key: 'country', label: 'Plugin country', type: 'text' },
  { key: 'language', label: 'Plugin language', type: 'text' },
  { key: 'danceability', label: 'Plugin danceability', type: 'number' },
] as const
