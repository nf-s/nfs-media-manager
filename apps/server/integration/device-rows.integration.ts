import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { artistBrowseFields } from '@repo/schemas/artist-browse'
import {
  albumBrowseFields,
  filmBrowseFields,
  trackBrowseFields,
  type BrowseFilter,
  type BrowseRange,
} from '@repo/schemas/browse'
import { ArtistQuerySchema } from '@repo/schemas/creators'
import {
  DeviceAlbumItemSchema,
  DeviceAlbumRowSchema,
  DeviceArtistItemSchema,
  DeviceArtistRowSchema,
  DeviceFilmItemSchema,
  DeviceFilmRowSchema,
  DeviceMetaRowSchema,
  DevicePlaylistItemSchema,
  DevicePlaylistJobRowSchema,
  DevicePlaylistRowSchema,
  DeviceScrobbleNameRowSchema,
  DeviceTagKeyRowSchema,
  DeviceTagLocationSchema,
  DeviceTagRowSchema,
  DeviceTrackItemSchema,
  DeviceTrackRowSchema,
  DeviceEntitySchema,
  type DeviceEntity,
  type DeviceTagLocation,
  type DeviceTrackRow,
} from '@repo/schemas/device'
import { AlbumQuerySchema, FilmQuerySchema } from '@repo/schemas/media'
import {
  PlaylistBrowseQuerySchema,
  TrackQuerySchema,
  trackAlbumLinkLabels,
  trackSourceLabels,
  trackSpotifyMatchLabels,
} from '@repo/schemas/tracks'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const name = `device_rows_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({
  ...connection,
  database: name,
  options: '-c timezone=UTC',
})
const fixture = drizzle(pool, { schema })

vi.mock('@/lib/db', () => ({
  get db() {
    return fixture
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [],
}))

const at = (iso: string) => Date.parse(iso)

let created = false
beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network requests are forbidden in integration tests')
    }),
  )
  await admin.connect()
  // The device orders text by code point. A C collation orders UTF-8 the
  // same way, so the service's orders can be compared with the device's.
  const { rows } = await admin.query<{ ctype: string }>(
    'select datctype as ctype from pg_database where datname = current_database()',
  )
  const ctype = z
    .string()
    .regex(/^[\w.@-]+$/)
    .parse(rows[0]?.ctype)
  // The identifier is generated locally from a UUID, never from user input.
  await admin.query(
    `create database ${name} template template0 encoding 'UTF8' lc_collate 'C' lc_ctype '${ctype}'`,
  )
  created = true
  await migrate(fixture, { migrationsFolder: './drizzle' })
  // An invented library: five artists, four albums (one archived, one an
  // edition), six tracks (two versions of one recording, one archived),
  // three films (one archived), two playlists and a collection.
  await pool.query(`
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
      ('fixture-listener', 'cedar echo', 'echelle', 'track-echo', 'similar');

    insert into scrape_job (id, provider, status, scope, options) values
      ('job-picks', 'spotify', 'running', '{}', '{"task": "spotify-playlist-import", "groupKey": "spotify:fixturePlaylistId0001",
        "progress": {"pagesRead": 1, "totalPages": 3}}'),
      ('job-liked', 'spotify', 'failed', '{}', '{"task": "spotify-playlist-import", "groupKey": "spotify-liked"}');
  `)
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${name}`)
  await admin.end()
  vi.unstubAllGlobals()
})

async function renderer() {
  return (await import('@/services/device-rows')).deviceRowRenderer
}

async function rows<T>(entity: DeviceEntity, parse: (value: unknown) => T) {
  const device = await renderer()
  const ids = await device.listIds(entity, null, 1000)
  const rendered = await device.render(entity, ids)
  return new Map([...rendered].map(([id, payload]) => [id, parse(payload)]))
}

const trackRows = () => rows('track', (v) => DeviceTrackRowSchema.parse(v))
const albumRows = () => rows('album', (v) => DeviceAlbumRowSchema.parse(v))
const filmRows = () => rows('film', (v) => DeviceFilmRowSchema.parse(v))
const artistRows = () => rows('artist', (v) => DeviceArtistRowSchema.parse(v))
const playlistRows = () =>
  rows('playlist', (v) => DevicePlaylistRowSchema.parse(v))
const playlistJobs = () =>
  rows('playlist_job', (v) => DevicePlaylistJobRowSchema.parse(v))

/** A sync group's latest job that has not succeeded: the device clears the next sync. */
function unfinishedJob(
  jobs: Map<string, { status: string }>,
  groupKey: string | null,
) {
  const job = groupKey === null ? undefined : jobs.get(groupKey)
  return job !== undefined && job.status !== 'succeeded'
}

// The device's order: by code point, numbers numerically, nulls last except
// where the service puts them first.
type Value = string | number | null
type OrderKey = { value: Value; descending?: boolean; nullsFirst?: boolean }

function codePoints(a: string, b: string) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b))
}

function compareKeys(left: OrderKey[], right: OrderKey[]) {
  for (const [index, a] of left.entries()) {
    const b = right[index]
    if (!b) return 0
    if (a.value === b.value) continue
    if (a.value === null) return a.nullsFirst ? -1 : 1
    if (b.value === null) return a.nullsFirst ? 1 : -1
    const order =
      typeof a.value === 'number' && typeof b.value === 'number'
        ? a.value - b.value
        : codePoints(String(a.value), String(b.value))
    if (order) return a.descending ? -order : order
  }
  return 0
}

function deviceOrder<T>(
  entries: Map<string, T>,
  keys: (row: T, id: string) => OrderKey[],
) {
  return [...entries]
    .sort(([a, left], [b, right]) => compareKeys(keys(left, a), keys(right, b)))
    .map(([id]) => id)
}

function locationOf(levels: string | undefined): DeviceTagLocation {
  return DeviceTagLocationSchema.parse(levels ?? 'auto')
}

function trackPrimary(row: DeviceTrackRow, key: string, levels?: string) {
  if (key === 'genre') return row.sort.genre[locationOf(levels)]
  if (key === 'releaseDate') return row.sort.releaseDate
  const sort = z.record(z.string(), z.unknown()).parse(row.sort)[key]
  const value =
    sort === undefined
      ? z.record(z.string(), z.unknown()).parse(row.num)[key]
      : sort
  return z.union([z.string(), z.number(), z.null()]).parse(value)
}

function trackNatural(row: DeviceTrackRow, primary: string): OrderKey[] {
  const { natural } = row.sort
  const grouped =
    primary === 'artist'
      ? [natural.year, row.sort.album]
      : primary === 'album'
        ? [natural.albumDate]
        : primary === 'releaseDate'
          ? [natural.artist, row.sort.album]
          : [natural.artist, natural.year, row.sort.album]
  return [
    ...grouped,
    row.extra.albumId,
    natural.spotifyAlbumId,
    natural.position,
    row.sort.title,
  ].map((value) => ({ value }))
}

const visibleTrack = (row: DeviceTrackRow) =>
  !row.extra.archived && !row.extra.redundantPlaceholder

function filtered<T>(entries: Map<string, T>, keep: (row: T) => boolean) {
  return new Map([...entries].filter(([, row]) => keep(row)))
}

const ValuesSchema = z.record(z.string(), z.array(z.string()))
const NumbersSchema = z.record(z.string(), z.number().nullable())

/** Filter and range semantics over the projected values (ASCII fixture values). */
function matches(
  row: { text: unknown; num: unknown },
  filters: BrowseFilter[],
  ranges: BrowseRange[],
  dates: ReadonlySet<string>,
) {
  const text = ValuesSchema.parse(row.text)
  const num = NumbersSchema.parse(row.num)
  const hit = (filter: BrowseFilter) =>
    (text[filter.field] ?? []).some(
      (value) => value.toLowerCase() === filter.value.toLowerCase(),
    )
  const required = filters.filter((filter) => filter.mode === 'required')
  const excluded = filters.filter((filter) => filter.mode === 'exclude')
  const any = filters.filter(
    (filter) => filter.mode !== 'required' && filter.mode !== 'exclude',
  )
  const scale = (field: string) => (dates.has(field) ? 1000 : 1)
  return (
    required.every(hit) &&
    !excluded.some(hit) &&
    (!any.length || any.some(hit)) &&
    ranges.every((range) => {
      const value = num[range.field] ?? null
      if (value === null) return range.includeMissing
      const factor = scale(range.field)
      return (
        (range.min === undefined || value >= range.min * factor) &&
        (range.max === undefined || value <= range.max * factor)
      )
    })
  )
}

const dateKeys = (fields: { key: string; type: string }[]) =>
  new Set(
    fields.filter((field) => field.type === 'date').map((field) => field.key),
  )

describe('the device row renderer', () => {
  it('lists published IDs in code-point order, in pages', async () => {
    const device = await renderer()
    const all = await device.listIds('track', null, 1000)
    expect(all).toEqual([...all].sort(codePoints))
    expect(all).toContain('track-delta')
    const first = await device.listIds('track', null, 2)
    const rest = await device.listIds('track', first.at(-1) ?? null, 1000)
    expect([...first, ...rest]).toEqual(all)
    for (const entity of DeviceEntitySchema.options) {
      const ids = await device.listIds(entity, null, 1000)
      expect(ids, entity).toEqual([...ids].sort(codePoints))
      expect(ids.length, entity).toBeGreaterThan(0)
      // Every listed ID renders, and its payload parses.
      expect(
        [...(await device.render(entity, ids)).keys()].sort(codePoints),
        entity,
      ).toEqual(ids)
    }
  })

  it('leaves out IDs that have no published row', async () => {
    const device = await renderer()
    const rendered = await device.render('album', [
      'album-north',
      'album-missing',
      'track-aurora',
    ])
    expect([...rendered.keys()]).toEqual(['album-north'])
    expect(await device.listIds('playlist', null, 10)).not.toContain(
      'collection-films',
    )
  })

  it('renders archived items with their flag and editions with theirs', async () => {
    const albums = await albumRows()
    expect(albums.get('album-archive')?.extra.archived).toBe(true)
    expect(albums.get('album-deluxe')?.extra.isEdition).toBe(true)
    expect(albums.get('album-north')?.extra.archived).toBe(false)
    expect((await trackRows()).get('track-delta')?.extra.archived).toBe(true)
  })

  it('writes dates as whole epoch microseconds and plugin values as browse fields', async () => {
    const track = (await trackRows()).get('track-aurora')
    expect(track?.num.dateAdded).toBe(Date.UTC(2023, 0, 1) * 1000 + 1)
    const album = (await albumRows()).get('album-north')
    expect(album?.num.dateAdded).toBe(Date.UTC(2021, 0, 1, 10) * 1000 + 654321)
    expect(album?.num.lastListenedAt).toBe(at('2024-05-06T07:08:09Z') * 1000)
    expect(album?.text.fixtureMood).toEqual(['Blue'])
    expect(album?.sort.fixtureMood).toBe('blue')
    expect(album?.num.fixtureScore).toBe(7)
    expect(album?.text.country).toEqual(['NZ'])
    const playlist = (await playlistRows()).get('playlist-picks')
    expect(playlist?.num.checked).toBe(
      Date.UTC(2022, 5, 2, 3, 4, 5) * 1000 + 678901,
    )
  })

  it('projects tags, credits, facts and recordings from the Browse expressions', async () => {
    const tracks = await trackRows()
    const aurora = tracks.get('track-aurora')
    expect(aurora?.search.artistTag).toEqual(['Ambient', 'Drone'])
    expect(aurora?.extra.artistTagLabelKeys).toEqual(['ambient', 'drone'])
    expect(aurora?.extra.artistTagKeys).toEqual(['ambient', 'drone'])
    expect(aurora?.extra.albumTagIds).toEqual([
      'tag-ambient',
      'tag-downtempo',
      'tag-electronic',
      'tag-hidden',
    ])
    expect(aurora?.extra.albumReleaseTagCount).toBe(3)
    expect(aurora?.search.albumTag).toEqual([
      'Ambient',
      'Downtempo',
      'Electronic',
    ])
    expect(aurora?.sort.genre.auto).toBe('ambient')
    expect(aurora?.text.source).toEqual([trackSourceLabels.album])
    expect(aurora?.extra.recording).toMatchObject({
      key: 'track-aurora',
      linked: true,
    })
    expect(tracks.get('track-aurora-live')?.extra.recording.key).toBe(
      'track-aurora',
    )
    const echo = tracks.get('track-echo')
    expect(echo?.extra.ownTagIds).toEqual(['tag-hidden', 'tag-pop'])
    expect(echo?.extra.ownSonovaultTagIds).toEqual(['tag-pop'])
    expect(echo?.extra.hasOwnTags).toBe(true)
    expect(echo?.search.trackTag).toEqual(['Pop'])
    expect(echo?.sort.musicalKey).toBe(16)
    expect(echo?.text.musicalKey).toEqual(['8A'])
    expect(tracks.get('track-bright')?.num.bpm).toBe(96.5)
    expect(tracks.get('track-cold')?.extra.artistIds).toEqual([
      'artist-birch',
      'artist-cedar',
    ])
    expect(tracks.get('track-cold')?.text.album).toEqual(['Loose Single'])
    const north = (await albumRows()).get('album-north')
    expect(north?.extra.releaseTagCount).toBe(3)
    expect(north?.extra.tagIds).toHaveLength(4)
    expect(north?.sort.genre.auto).toBe('ambient')
    expect(north?.text.provider).toEqual(['discogs'])
    const harbor = (await filmRows()).get('film-harbor')
    expect(harbor?.extra.creditIds).toEqual({
      director: ['artist-delta'],
      actor: ['artist-echo'],
    })
    expect(harbor?.search.genre).toEqual(['Drama', 'Noir'])
    expect(harbor?.text.identification).toEqual(['Identified'])
    const aster = (await artistRows()).get('artist-aster')
    expect(aster?.search.name).toEqual(['Aster Vale', 'Vale, Aster'])
    expect(aster?.extra.playlistIds).toEqual([
      'playlist-morning',
      'playlist-picks',
    ])
    expect(aster?.extra.rawTagKeys).toEqual(['ambient', 'drone'])
  })

  it('renders a running import with its status only', async () => {
    const device = await renderer()
    const jobs = await device.render('playlist_job', [
      'spotify:fixturePlaylistId0001',
      'spotify-liked',
    ])
    expect(
      DevicePlaylistJobRowSchema.parse(
        jobs.get('spotify:fixturePlaylistId0001'),
      ),
    ).toMatchObject({
      jobId: 'job-picks',
      status: 'running',
      progress: null,
      activity: null,
    })
    expect(
      DevicePlaylistJobRowSchema.parse(jobs.get('spotify-liked')),
    ).toMatchObject({
      jobId: 'job-liked',
      status: 'failed',
    })
  })

  it('renders tags, tag keys, play times and meta rows', async () => {
    const device = await renderer()
    const tags = await device.render('tag', [
      'tag-electronica',
      'tag-electronic',
    ])
    expect(DeviceTagRowSchema.parse(tags.get('tag-electronica'))).toMatchObject(
      {
        key: 'electronica',
        aliasTargetId: 'tag-electronic',
      },
    )
    expect(
      DeviceTagRowSchema.parse(tags.get('tag-electronic')).identityKeys,
    ).toEqual(['electronic music'])
    const keys = await device.render('tag_key', [
      'album:dream pop',
      'film:noir',
      'album:none',
    ])
    expect([...keys.keys()].sort()).toEqual(['album:dream pop', 'film:noir'])
    expect(
      DeviceTagKeyRowSchema.parse(keys.get('film:noir')).ancestorKeys,
    ).toEqual(['drama'])
    const track = (await trackRows()).get('track-aurora')
    const names = await device.render(
      'scrobble_name',
      track?.extra.scrobbleNameIds ?? [],
    )
    expect(
      [...names.values()].map(
        (row) => DeviceScrobbleNameRowSchema.parse(row).plays,
      ),
    ).toEqual([
      [
        at('2024-05-01T10:00:00Z') / 1000,
        at('2024-05-06T00:00:00Z') / 1000,
        at('2024-05-07T00:00:00Z') / 1000,
      ],
    ])
    const albumPlays = await device.render('album_plays', [
      'album-north',
      'album-quiet',
    ])
    expect([...albumPlays.keys()]).toEqual(['album-north'])
    const artistPlays = await device.render('artist_plays', ['artist-aster'])
    expect(artistPlays.get('artist-aster')).toEqual({
      plays: [
        at('2024-05-01T10:00:00Z') / 1000,
        at('2024-05-06T00:00:00Z') / 1000,
        at('2024-05-07T00:00:00Z') / 1000,
      ],
    })
    const meta = await device.render(
      'meta',
      await device.listIds('meta', null, 10),
    )
    expect(DeviceMetaRowSchema.parse(meta.get('listening'))).toEqual({
      kind: 'listening',
      historyStart: '2024-01-01',
    })
    expect(DeviceMetaRowSchema.parse(meta.get('fields:artist'))).toMatchObject({
      kind: 'fields',
      fields: artistBrowseFields,
    })
  })

  it('keys scrobbled names as the feed marks them and expands title peers', async () => {
    const device = await renderer()
    const { rows: marked } = await pool.query<{ id: string }>(
      `select device_scrobble_name_id(username, artist_key, track_key) as id
        from lastfm_track_link where track_media_item_id = 'track-aurora'`,
    )
    expect(
      (await trackRows()).get('track-aurora')?.extra.scrobbleNameIds,
    ).toEqual(marked.map((row) => row.id))
    expect(await device.listIds('scrobble_name', null, 10)).toContain(
      marked[0]?.id,
    )
    expect(await device.expand?.('track', ['track-aurora'])).toEqual([
      'track-aurora-live',
    ])
    expect(await device.expand?.('album', ['album-north'])).toEqual([])
  })

  it('fails loudly on a fractional play time', async () => {
    const device = await renderer()
    await pool.query(
      `update lastfm_scrobble set listened_at = listened_at + interval '0.5 seconds' where id = 'scrobble-4'`,
    )
    try {
      await expect(
        device.render('artist_plays', ['artist-cedar']),
      ).rejects.toThrow('not a whole second')
    } finally {
      await pool.query(
        `update lastfm_scrobble set listened_at = '2024-01-01 00:00:00' where id = 'scrobble-4'`,
      )
    }
  })
})

describe('item rows equal the list endpoints', () => {
  it('Tracks', async () => {
    const { listTracks } = await import('@/services/tracks')
    const device = await trackRows()
    const { items } = await listTracks(TrackQuerySchema.parse({ size: 100 }))
    expect(items.length).toBeGreaterThan(3)
    for (const item of items)
      expect(device.get(item.id)?.item, item.id).toEqual(
        JSON.parse(JSON.stringify(DeviceTrackItemSchema.parse(item))),
      )
  })

  it('Albums and Films', async () => {
    const { listAlbums, listFilms } = await import('@/services/media')
    const albums = await albumRows()
    const albumItems = (
      await listAlbums(
        AlbumQuerySchema.parse({
          includeArchived: 'true',
          editions: 'true',
          size: 100,
        }),
      )
    ).items
    expect(albumItems).toHaveLength(4)
    for (const item of albumItems)
      expect(albums.get(item.id)?.item, item.id).toEqual(
        JSON.parse(JSON.stringify(DeviceAlbumItemSchema.parse(item))),
      )
    const films = await filmRows()
    const filmItems = (
      await listFilms(
        FilmQuerySchema.parse({ includeArchived: 'true', size: 100 }),
      )
    ).items
    expect(filmItems).toHaveLength(3)
    for (const item of filmItems)
      expect(films.get(item.id)?.item, item.id).toEqual(
        JSON.parse(JSON.stringify(DeviceFilmItemSchema.parse(item))),
      )
  })

  it('Artists and Playlists', async () => {
    const { listArtistBrowsePage } = await import('@/services/artist-browse')
    const { listPlaylistBrowsePage } =
      await import('@/services/playlist-directory')
    const artists = await artistRows()
    const page = await listArtistBrowsePage(
      ArtistQuerySchema.parse({ size: 100 }),
    )
    expect(page.items.map((item) => item.id).sort()).toEqual(
      [...artists.keys()].sort(),
    )
    for (const item of page.items)
      expect(artists.get(item.id)?.item, item.id).toEqual(
        JSON.parse(JSON.stringify(DeviceArtistItemSchema.parse(item))),
      )
    const playlists = await playlistRows()
    const jobs = await playlistJobs()
    const directory = await listPlaylistBrowsePage(
      PlaylistBrowseQuerySchema.parse({}),
    )
    expect(directory.items.map((item) => item.id).sort()).toEqual(
      [...playlists.keys()].sort(),
    )
    for (const item of directory.items) {
      const row = playlists.get(item.id)
      if (!row) throw new Error(`${item.id} has a row`)
      // The device takes the job from its playlist_job row.
      const pending = unfinishedJob(jobs, row.extra.syncGroupKey)
      expect(
        {
          ...row.item,
          sync: {
            ...row.item.sync,
            nextScheduledAt: pending ? null : row.item.sync.nextScheduledAt,
          },
        },
        item.id,
      ).toEqual(
        JSON.parse(JSON.stringify(DevicePlaylistItemSchema.parse(item))),
      )
    }
  })
})

describe('ordering by the projected sort values gives the service order', () => {
  const directions: ('asc' | 'desc')[] = ['asc', 'desc']

  it('Tracks, for every sort key and Tags location', async () => {
    const { queryBrowseIds } = await import('@/services/browse')
    const device = filtered(await trackRows(), visibleTrack)
    const sorts = trackBrowseFields.flatMap((field) =>
      field.key === 'genre'
        ? DeviceTagLocationSchema.options.map((location) => ({
            key: field.key,
            levels: location === 'auto' ? undefined : location,
          }))
        : [{ key: field.key, levels: undefined }],
    )
    for (const { key, levels } of sorts)
      for (const direction of directions) {
        const service = await queryBrowseIds(
          'track',
          TrackQuerySchema.parse({
            sortBy: key,
            direction,
            size: 100,
            tagLevels: levels,
          }),
        )
        const expected = deviceOrder(device, (row, id) => [
          {
            value: trackPrimary(row, key, levels),
            descending: direction === 'desc',
            nullsFirst: key === 'title' && direction === 'desc',
          },
          ...trackNatural(row, key),
          { value: id },
        ])
        expect(service.ids, `${key} ${levels ?? 'auto'} ${direction}`).toEqual(
          expected,
        )
      }
  })

  it('Albums and Films, for every sort key', async () => {
    const { queryBrowseIds } = await import('@/services/browse')
    const libraries: {
      library: 'album' | 'film'
      fields: typeof albumBrowseFields
      rows: Map<string, { sort: unknown; num: unknown }>
      query: typeof AlbumQuerySchema | typeof FilmQuerySchema
    }[] = [
      {
        library: 'album',
        fields: albumBrowseFields,
        rows: filtered(
          await albumRows(),
          (row) => !row.extra.archived && !row.extra.isEdition,
        ),
        query: AlbumQuerySchema,
      },
      {
        library: 'film',
        fields: filmBrowseFields,
        rows: filtered(await filmRows(), (row) => !row.extra.archived),
        query: FilmQuerySchema,
      },
    ]
    for (const { library, fields, rows: device, query } of libraries)
      for (const field of fields)
        for (const direction of directions) {
          const service = await queryBrowseIds(
            library,
            query.parse({ sortBy: field.key, direction, size: 100 }),
          )
          const expected = deviceOrder(device, (row, id) => {
            const sort = z.record(z.string(), z.unknown()).parse(row.sort)
            const value =
              field.type === 'text'
                ? field.key === 'genre' && library === 'album'
                  ? z
                      .record(z.string(), z.string().nullable())
                      .parse(sort.genre).auto
                  : sort[field.key]
                : NumbersSchema.parse(row.num)[field.key]
            return [
              {
                value: z
                  .union([z.string(), z.number(), z.null()])
                  .parse(value ?? null),
                descending: direction === 'desc',
                nullsFirst: field.key === 'title' && direction === 'desc',
              },
              { value: id },
            ]
          })
          expect(service.ids, `${library} ${field.key} ${direction}`).toEqual(
            expected,
          )
        }
  })

  it('Artists and Playlists, for every sort key', async () => {
    const { listArtistBrowsePage } = await import('@/services/artist-browse')
    const { listPlaylistBrowsePage } =
      await import('@/services/playlist-directory')
    const artists = await artistRows()
    for (const field of artistBrowseFields)
      for (const direction of directions) {
        const page = await listArtistBrowsePage(
          ArtistQuerySchema.parse({ sortBy: field.key, direction, size: 100 }),
        )
        const expected = deviceOrder(artists, (row, id) => [
          {
            value:
              field.type === 'text'
                ? row.sort[
                    DeviceArtistRowSchema.shape.sort.keyof().parse(field.key)
                  ]
                : row.num[
                    DeviceArtistRowSchema.shape.num.keyof().parse(field.key)
                  ],
            descending: direction === 'desc',
          },
          { value: id },
        ])
        expect(
          page.items.map((item) => item.id),
          `artist ${field.key} ${direction}`,
        ).toEqual(expected)
      }
    const playlists = await playlistRows()
    const jobs = await playlistJobs()
    const numberSorts = new Set(
      Object.keys(DevicePlaylistRowSchema.shape.num.shape),
    )
    for (const sortBy of [
      ...Object.keys(DevicePlaylistRowSchema.shape.sort.shape),
      ...numberSorts,
    ])
      for (const direction of directions) {
        const page = await listPlaylistBrowsePage(
          PlaylistBrowseQuerySchema.parse({ sortBy, direction }),
        )
        const expected = deviceOrder(playlists, (row, id) => [
          {
            value: z
              .union([z.string(), z.number(), z.null()])
              .parse(
                sortBy === 'nextSync' &&
                  unfinishedJob(jobs, row.extra.syncGroupKey)
                  ? null
                  : z
                      .record(z.string(), z.unknown())
                      .parse(numberSorts.has(sortBy) ? row.num : row.sort)[
                      sortBy
                    ],
              ),
            descending: direction === 'desc',
          },
          { value: row.sort.name },
          { value: id },
        ])
        expect(
          page.items.map((item) => item.id),
          `playlist ${sortBy} ${direction}`,
        ).toEqual(expected)
      }
  })
})

describe('filtering by the projected values gives the service set', () => {
  it('Tracks', async () => {
    const { queryBrowseIds } = await import('@/services/browse')
    const device = filtered(await trackRows(), visibleTrack)
    const cases: { filters: BrowseFilter[]; ranges: BrowseRange[] }[] = [
      {
        filters: [{ field: 'title', value: 'aurora', mode: 'required' }],
        ranges: [],
      },
      {
        filters: [{ field: 'artist', value: 'BIRCH UNIT', mode: 'required' }],
        ranges: [],
      },
      {
        filters: [{ field: 'artist', value: 'Aster Vale', mode: 'exclude' }],
        ranges: [],
      },
      {
        filters: [{ field: 'album', value: 'Loose Single', mode: 'required' }],
        ranges: [],
      },
      {
        filters: [{ field: 'album', value: 'quiet fields', mode: 'required' }],
        ranges: [],
      },
      {
        filters: [
          { field: 'playlist', value: 'Morning Mix', mode: 'required' },
        ],
        ranges: [],
      },
      {
        filters: [
          { field: 'source', value: trackSourceLabels.album, mode: 'required' },
        ],
        ranges: [],
      },
      {
        filters: [
          {
            field: 'source',
            value: trackSourceLabels.spotify,
            mode: 'exclude',
          },
        ],
        ranges: [],
      },
      {
        filters: [
          {
            field: 'spotifyMatch',
            value: trackSpotifyMatchLabels.unmatched,
            mode: 'required',
          },
        ],
        ranges: [],
      },
      {
        filters: [
          {
            field: 'albumLink',
            value: trackAlbumLinkLabels.unlinked,
            mode: 'required',
          },
        ],
        ranges: [],
      },
      {
        filters: [{ field: 'hasTrackTags', value: 'yes', mode: 'required' }],
        ranges: [],
      },
      {
        filters: [{ field: 'provider', value: 'musicbrainz', mode: 'exclude' }],
        ranges: [],
      },
      {
        filters: [{ field: 'musicalKey', value: '8A', mode: 'required' }],
        ranges: [],
      },
      {
        filters: [
          { field: 'title', value: 'Bright Water' },
          { field: 'artist', value: 'Cedar Echo' },
        ],
        ranges: [],
      },
      {
        filters: [],
        ranges: [
          { field: 'durationSec', min: 190, max: 230, includeMissing: false },
        ],
      },
      {
        filters: [],
        ranges: [{ field: 'durationSec', min: 190, includeMissing: true }],
      },
      {
        filters: [],
        ranges: [{ field: 'bpm', max: 100, includeMissing: false }],
      },
      {
        filters: [],
        ranges: [
          {
            field: 'dateAdded',
            min: Date.UTC(2023, 0, 1),
            max: Date.UTC(2023, 2, 1),
            includeMissing: false,
          },
        ],
      },
      {
        filters: [],
        ranges: [
          {
            field: 'releaseDate',
            max: Date.UTC(2005, 0, 1),
            includeMissing: false,
          },
        ],
      },
      {
        filters: [],
        ranges: [{ field: 'scrobbles', min: 1, includeMissing: false }],
      },
    ]
    for (const { filters, ranges } of cases) {
      const service = await queryBrowseIds(
        'track',
        TrackQuerySchema.parse({
          filters: JSON.stringify(filters),
          ranges: JSON.stringify(ranges),
          size: 100,
        }),
      )
      const expected = [...device]
        .filter(([, row]) =>
          matches(row, filters, ranges, dateKeys(trackBrowseFields)),
        )
        .map(([id]) => id)
      expect(service.ids.sort(), JSON.stringify({ filters, ranges })).toEqual(
        expected.sort(),
      )
    }
  })

  it('Albums, Films and Artists', async () => {
    const { queryBrowseIds } = await import('@/services/browse')
    const { listArtistBrowsePage } = await import('@/services/artist-browse')
    const albums = filtered(
      await albumRows(),
      (row) => !row.extra.archived && !row.extra.isEdition,
    )
    const albumFilters: BrowseFilter[][] = [
      [{ field: 'artist', value: 'aster vale', mode: 'required' }],
      [{ field: 'country', value: 'au', mode: 'required' }],
      [{ field: 'playlist', value: 'Morning Mix', mode: 'required' }],
      [{ field: 'source', value: 'spotify', mode: 'exclude' }],
      [{ field: 'provider', value: 'Discogs', mode: 'required' }],
    ]
    for (const filters of albumFilters) {
      const service = await queryBrowseIds(
        'album',
        AlbumQuerySchema.parse({ filters: JSON.stringify(filters), size: 100 }),
      )
      const expected = [...albums]
        .filter(([, row]) =>
          matches(row, filters, [], dateKeys(albumBrowseFields)),
        )
        .map(([id]) => id)
      expect(service.ids.sort(), JSON.stringify(filters)).toEqual(
        expected.sort(),
      )
    }
    const albumRanges: BrowseRange[][] = [
      [{ field: 'ratingRymValue', min: 4, includeMissing: false }],
      [
        {
          field: 'lastListenedAt',
          min: at('2024-01-01T00:00:00Z'),
          includeMissing: false,
        },
      ],
      [
        {
          field: 'dateAdded',
          max: Date.UTC(2021, 0, 15),
          includeMissing: false,
        },
      ],
      [{ field: 'durationSec', min: 2000, includeMissing: true }],
    ]
    for (const ranges of albumRanges) {
      const service = await queryBrowseIds(
        'album',
        AlbumQuerySchema.parse({ ranges: JSON.stringify(ranges), size: 100 }),
      )
      const expected = [...albums]
        .filter(([, row]) =>
          matches(row, [], ranges, dateKeys(albumBrowseFields)),
        )
        .map(([id]) => id)
      expect(service.ids.sort(), JSON.stringify(ranges)).toEqual(
        expected.sort(),
      )
    }
    const films = filtered(await filmRows(), (row) => !row.extra.archived)
    const filmFilters: BrowseFilter[][] = [
      [{ field: 'director', value: 'delta ray', mode: 'required' }],
      [{ field: 'actor', value: 'Echo Lin', mode: 'exclude' }],
      [{ field: 'country', value: 'AU', mode: 'required' }],
      [{ field: 'collection', value: 'Film Picks', mode: 'required' }],
      [{ field: 'source', value: 'plex', mode: 'required' }],
      [{ field: 'watched', value: 'Yes', mode: 'required' }],
      [{ field: 'identification', value: 'Identified', mode: 'required' }],
    ]
    for (const filters of filmFilters) {
      const service = await queryBrowseIds(
        'film',
        FilmQuerySchema.parse({ filters: JSON.stringify(filters), size: 100 }),
      )
      const expected = [...films]
        .filter(([, row]) =>
          matches(row, filters, [], dateKeys(filmBrowseFields)),
        )
        .map(([id]) => id)
      expect(service.ids.sort(), JSON.stringify(filters)).toEqual(
        expected.sort(),
      )
    }
    const artists = await artistRows()
    const artistFilters: BrowseFilter[][] = [
      [{ field: 'name', value: 'BIRCH unit', mode: 'required' }],
      [{ field: 'country', value: 'nz', mode: 'required' }],
      [{ field: 'type', value: 'Person', mode: 'exclude' }],
      [{ field: 'provider', value: 'lastfm', mode: 'required' }],
      [{ field: 'playlist', value: 'Spotify Picks', mode: 'required' }],
    ]
    for (const filters of artistFilters) {
      const page = await listArtistBrowsePage(
        ArtistQuerySchema.parse({
          filters: JSON.stringify(filters),
          size: 100,
        }),
      )
      const expected = [...artists]
        .filter(([, row]) =>
          matches(row, filters, [], dateKeys(artistBrowseFields)),
        )
        .map(([id]) => id)
      expect(
        page.items.map((item) => item.id).sort(),
        JSON.stringify(filters),
      ).toEqual(expected.sort())
    }
  })
})

describe('recording keys', () => {
  it('reproduce the grouped Tracks result outside a creator scope', async () => {
    const { listTracks } = await import('@/services/tracks')
    const device = filtered(await trackRows(), visibleTrack)
    const groups = new Map<string, [string, DeviceTrackRow][]>()
    for (const [id, row] of device) {
      const key = row.extra.recording.key ?? id
      groups.set(key, [...(groups.get(key) ?? []), [id, row]])
    }
    expect(device.get('track-aurora')?.extra.recording.key).toBe('track-aurora')
    expect(device.get('track-bright')?.extra.recording.key).toBeNull()
    const representatives = [...groups.values()].map((members) => {
      const [first] = [...members].sort(([a, left], [b, right]) =>
        compareKeys(
          [
            { value: Number(left.extra.recording.shown), descending: true },
            { value: Number(left.extra.recording.playable), descending: true },
            { value: Number(left.extra.recording.linked), descending: true },
            { value: left.extra.recording.releaseDate },
            { value: a },
          ],
          [
            { value: Number(right.extra.recording.shown) },
            { value: Number(right.extra.recording.playable) },
            { value: Number(right.extra.recording.linked) },
            { value: right.extra.recording.releaseDate },
            { value: b },
          ],
        ),
      )
      if (!first) throw new Error('A group has members')
      return { id: first[0], row: first[1], versions: members.length }
    })
    const expected = [...representatives]
      .sort((left, right) =>
        compareKeys(
          [
            { value: left.row.sort.title },
            ...trackNatural(left.row, 'title'),
            { value: left.id },
          ],
          [
            { value: right.row.sort.title },
            ...trackNatural(right.row, 'title'),
            { value: right.id },
          ],
        ),
      )
      .map(({ id, versions }) => ({
        id,
        versions: versions > 1 ? versions : undefined,
      }))
    const { items } = await listTracks(
      TrackQuerySchema.parse({
        groupRecordings: true,
        sortBy: 'title',
        direction: 'asc',
        size: 100,
      }),
    )
    expect(
      items.map((item) => ({
        id: item.id,
        versions: item.recordingGroup?.versionCount,
      })),
    ).toEqual(expected)
  })
})
