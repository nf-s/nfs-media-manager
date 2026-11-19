import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PluginResultSchema, type JsonValue } from '@repo/media-plugin-sdk'
import { MatchDiagnosticsQuerySchema } from '@repo/schemas/match-diagnostics'
import { env } from '@/env'
import { getBuiltinProviderCatalog } from '@/lib/provider-catalog'
import * as schema from '@/schemas/db'
import {
  listAlbumMatchRejections,
  readAlbumMatchRejections,
  rejectAlbumMatch,
} from '@/services/album-match-rejections'
import { getMediaHistory, getMediaSourceSnapshot } from '@/services/history'
import { listMediaMatchDiagnostics } from '@/services/media-match-diagnostics'
import { applyProviderResult } from '@/services/provider-state'

const database = 'media_matches_' + randomUUID().replaceAll('-', '')
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })
const fetch = vi.fn<typeof globalThis.fetch>()

vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', async (load) => ({
  ...(await load<typeof import('@/plugins/registry')>()),
  listProviderCatalog: async () => getBuiltinProviderCatalog(),
}))
vi.mock('@/services/lastfm-scrobbles', () => ({
  getLastfmAccount: async () => 'listener-fixture',
}))

let created = false
beforeAll(async () => {
  fetch.mockRejectedValue(new Error('Unexpected provider request'))
  vi.stubGlobal('fetch', fetch)
  await admin.connect()
  await admin.query('create database ' + database)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
  await databaseClient.insert(schema.mediaItem).values([
    {
      id: 'album-one',
      slug: 'album-one',
      title: 'Alpha Album',
      mediaType: 'album',
    },
    {
      id: 'album-two',
      slug: 'album-two',
      title: 'Beta Album',
      mediaType: 'album',
    },
    {
      id: 'album-three',
      slug: 'album-three',
      title: 'Gamma Album',
      mediaType: 'album',
    },
    {
      id: 'album-four',
      slug: 'album-four',
      title: 'Delta Album',
      mediaType: 'album',
    },
    {
      id: 'film-one',
      slug: 'film-one',
      title: 'The Library Film',
      mediaType: 'film',
    },
    {
      id: 'film-without-evidence',
      slug: 'film-without-evidence',
      title: 'Unmatched Film',
      mediaType: 'film',
    },
    {
      id: 'film-archived',
      slug: 'film-archived',
      title: 'Archived Film',
      mediaType: 'film',
      metadata: { legacyHidden: true },
    },
  ])
  await databaseClient
    .insert(schema.album)
    .values([
      { mediaItemId: 'album-one' },
      { mediaItemId: 'album-two' },
      { mediaItemId: 'album-three' },
      { mediaItemId: 'album-four' },
    ])
  await databaseClient
    .insert(schema.film)
    .values([
      { mediaItemId: 'film-one' },
      { mediaItemId: 'film-without-evidence' },
      { mediaItemId: 'film-archived' },
    ])
  await databaseClient.insert(schema.artist).values([
    { id: 'library-artist', name: 'Library Artist' },
    { id: 'library-director', name: 'Library Director' },
    { id: 'library-actor', name: 'Library Actor' },
  ])
  await databaseClient.insert(schema.mediaCredit).values([
    { mediaItemId: 'album-one', artistId: 'library-artist', role: 'artist' },
    { mediaItemId: 'film-one', artistId: 'library-director', role: 'director' },
    { mediaItemId: 'film-one', artistId: 'library-actor', role: 'actor' },
  ])

  await databaseClient.insert(schema.providerCurrentState).values([
    {
      id: 'album-one-spotify',
      mediaItemId: 'album-one',
      provider: 'spotify',
      status: 'ready',
      checksum: 'fixture',
      payload: {
        name: 'Zulu Edition',
        artists: [{ name: 'Spotify Artist' }],
        secretFixtureField: 'omitted',
      },
      normalizedData: {
        mediaPatch: { title: 'Alpha Album' },
        references: [
          {
            referenceType: 'album',
            externalId: 'recorded-identifier',
            isPrimary: true,
          },
        ],
      },
    },
    {
      id: 'album-two-spotify',
      mediaItemId: 'album-two',
      provider: 'spotify',
      status: 'ready',
      checksum: 'fixture',
      payload: {
        spotify: {
          name: 'A Spotify Release',
          artists: [{ name: 'Other Spotify Artist' }],
        },
      },
    },
    {
      id: 'album-one-musicbrainz',
      mediaItemId: 'album-one',
      provider: 'musicbrainz',
      status: 'ready',
      checksum: 'fixture',
      payload: {
        releaseGroup: {
          title: 'Release Group',
          'artist-credit': [
            { name: 'As Credited', artist: { name: 'Artist Record' } },
          ],
        },
      },
    },
    {
      id: 'album-one-discogs',
      mediaItemId: 'album-one',
      provider: 'discogs',
      status: 'ready',
      checksum: 'fixture',
      payload: {
        master: {
          title: 'Master Release',
          artists: [{ name: 'Discogs Credit' }],
        },
        mainRelease: { title: 'Different Edition' },
      },
    },
    {
      id: 'album-one-lastfm',
      mediaItemId: 'album-one',
      provider: 'lastfm',
      status: 'ready',
      checksum: 'fixture',
      payload: {
        album: {
          name: 'Last.fm Album',
          artist: { name: 'Last.fm Artist' },
          url: 'https://www.last.fm/music/Artist/Album?fixture=omitted',
        },
      },
    },
    {
      id: 'album-one-serply',
      mediaItemId: 'album-one',
      provider: 'serply',
      status: 'ready',
      checksum: 'fixture',
      payload: {
        searches: [
          {
            query: 'Library input',
            response: {
              results: [
                {
                  link: 'https://example.test/unselected',
                  title: 'Unselected Album by Unselected Artist - RYM',
                },
                {
                  link: 'https://example.test/selected',
                  title: 'Indexed Album by Indexed Artist - RYM',
                },
              ],
            },
          },
        ],
      },
      normalizedData: {
        mediaPatch: {
          metadata: {
            'plugin.serply.provenance': {
              sourceUrl: 'https://example.test/selected',
            },
          },
        },
      },
    },
    {
      id: 'album-one-google',
      mediaItemId: 'album-one',
      provider: 'google-custom-search',
      status: 'ready',
      checksum: 'fixture',
      payload: {
        rymGoogle: {
          link: 'https://rateyourmusic.com/release/album/fixture/record/',
          rawResponse: {
            title:
              'Winter Record by Source Artist (Album, Ambient): Reviews, Ratings, Credits - Rate Your Music',
          },
        },
        metacriticGoogle: {
          link: 'https://www.metacritic.com/music/autumn-review/fixture/?ignored=value',
          rawResponse: {
            title:
              'Autumn Review by Recorded Artist Reviews and Tracks - Metacritic',
          },
        },
      },
      normalizedData: {
        mediaPatch: { title: 'Older Normalized Name' },
        references: [
          {
            referenceType: 'rym-url',
            externalId:
              'https://rateyourmusic.com/release/album/fixture/record/',
          },
        ],
      },
    },
    {
      id: 'album-one-legacy-browser',
      mediaItemId: 'album-one',
      provider: 'legacy-browser',
      status: 'ready',
      checksum: 'fixture',
      payload: {
        links: {
          rym: {
            href: 'https://rateyourmusic.com/release/album/fixture/previous/',
            title: 'Older Browser Match by Source Artist - RYM',
          },
          metacritic: {
            href: 'https://www.metacritic.com/music/previous-review/fixture/',
            title:
              'Older Browser Metacritic Match by Source Artist - Metacritic',
          },
        },
      },
    },
    {
      id: 'album-two-google',
      mediaItemId: 'album-two',
      provider: 'google-custom-search',
      status: 'ready',
      checksum: 'fixture',
      payload: { metacriticGoogle: { rating: { value: 80 } } },
      normalizedData: {
        mediaPatch: { title: 'A Standalone Metacritic Match' },
        references: [
          {
            referenceType: 'metacritic-url',
            externalId: 'https://www.metacritic.com/music/fixture/',
          },
        ],
      },
    },
    {
      id: 'album-two-legacy-record',
      mediaItemId: 'album-two',
      provider: 'legacy-record',
      status: 'ready',
      checksum: 'fixture',
      payload: {
        rymGoogle: {
          link: 'https://rateyourmusic.com.example.test/release/album/fixture/record/',
          rawResponse: { title: 'Unrelated Website Title' },
        },
        metacriticGoogle: {
          link: 'https://www.metacritic.com/music/%2e%2e/movie/unrelated/',
          rawResponse: { title: 'Unrelated Movie Match' },
        },
      },
    },
    {
      id: 'album-two-legacy-browser',
      mediaItemId: 'album-two',
      provider: 'legacy-browser',
      status: 'ready',
      checksum: 'fixture',
      payload: {
        title: 'Beta Album',
        links: {
          rym: {
            href: 'https://rateyourmusic.com/release/album/fixture/edition/?ignored=value',
            title: 'Dawn Edition by Other Source Artist - RYM',
          },
          metacritic: {
            href: 'https://metacritic.com.example.test/music/unrelated',
            title: 'Unrelated Metacritic Title',
          },
        },
      },
      normalizedData: { mediaPatch: { title: 'Beta Album' } },
    },
    {
      id: 'album-three-legacy-browser',
      mediaItemId: 'album-three',
      provider: 'legacy-browser',
      status: 'ready',
      checksum: 'fixture',
      payload: {
        links: {
          rym: {
            href: 'https://rateyourmusic.com/release/album/fixture/another-record/',
            title: 'Unrelated Browser Match by Source Artist - RYM',
          },
          metacritic: {
            href: 'https://metacritic.com/music/archive-review/fixture/critic-reviews/#ignored',
            title:
              'Critic Reviews for Archive Review by Source Duo - Metacritic',
          },
        },
      },
    },
    {
      id: 'album-three-google',
      mediaItemId: 'album-three',
      provider: 'google-custom-search',
      status: 'ready',
      checksum: 'fixture',
      payload: {
        rymGoogle: {
          link: 'https://rateyourmusic.com/release/album/fixture/link-only.p/reviews/1/#ignored',
          rawResponse: { title: 12 },
        },
        metacriticGoogle: {
          link: 'https://metacritic.com/music/archive-review/fixture/critic-reviews/',
          rawResponse: { title: null },
        },
      },
    },
    {
      id: 'album-four-google',
      mediaItemId: 'album-four',
      provider: 'google-custom-search',
      status: 'ready',
      checksum: 'fixture',
      payload: {
        metacriticGoogle: {
          link: 'https://www.metacritic.com/music/morning-chronicle/fixture/user-reviews/',
          rawResponse: {
            title: 'Morning Chronicle by Paper Trio Reviews and Tracks ...',
          },
        },
      },
      normalizedData: {
        references: [
          {
            referenceType: 'metacritic-url',
            externalId:
              'https://www.metacritic.com/music/morning-chronicle/fixture/user-reviews/',
          },
        ],
      },
    },
    {
      id: 'film-one-tmdb',
      mediaItemId: 'film-one',
      provider: 'tmdb',
      status: 'ready',
      checksum: 'fixture',
      payload: {
        title: 'Localized Film',
        credits: {
          crew: [
            { name: 'TMDb Director', job: 'Director' },
            { name: 'TMDb Writer', job: 'Writer' },
          ],
        },
      },
      normalizedData: {
        references: [
          { referenceType: 'imdb', externalId: 'tt10001' },
          { referenceType: 'tmdb', externalId: '10001', isPrimary: true },
        ],
      },
    },
    {
      id: 'film-one-extension',
      mediaItemId: 'film-one',
      provider: 'sample-extension',
      status: 'ready',
      checksum: 'fixture',
      payload: { title: 'Opaque payload' },
      normalizedData: {
        mediaPatch: { title: 'Documented Film' },
        credits: [
          { name: 'Extension Director', role: 'director' },
          { name: 'Extension Actor', role: 'actor' },
        ],
      },
    },
    {
      id: 'film-archived-tmdb',
      mediaItemId: 'film-archived',
      provider: 'tmdb',
      status: 'ready',
      checksum: 'fixture',
      payload: { title: 'Excluded Film' },
    },
  ])
  await databaseClient.insert(schema.providerReferenceOverride).values({
    id: 'pending-override',
    mediaItemId: 'album-one',
    provider: 'spotify',
    referenceType: 'album',
    externalId: 'not-yet-observed',
  })
  const listening = {
    albumMediaItemId: 'album-one',
    albumName: 'Scrobbled Album',
    albumKey: 'scrobbled album',
    artistName: 'Scrobbled Artist',
    artistKey: 'scrobbled artist',
    trackName: 'Track',
    trackKey: 'track',
    listenedAt: new Date('2025-01-01T00:00:00Z'),
  }
  await databaseClient.insert(schema.lastfmScrobble).values([
    { ...listening, id: 'listening-one', username: 'listener-fixture' },
    { ...listening, id: 'listening-two', username: 'listener-fixture' },
    {
      ...listening,
      id: 'listening-three',
      username: 'listener-fixture',
      albumName: 'SCROBBLED ALBUM',
    },
    {
      ...listening,
      id: 'listening-other',
      username: 'other-listener-fixture',
      albumName: 'Other account album',
    },
  ])
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query('drop database ' + database)
  await admin.end()
  vi.unstubAllGlobals()
})

describe('album and film match diagnostics', () => {
  it('shows observed album titles and credited names without provider requests', async () => {
    const result = await listMediaMatchDiagnostics(
      'album',
      MatchDiagnosticsQuerySchema.parse({ size: 1 }),
    )
    expect(result).toMatchObject({
      totalCount: 4,
      pageCount: 4,
      items: [
        { id: 'album-one', name: 'Alpha Album', creator: 'Library Artist' },
      ],
    })
    const matches = result.items[0]?.matches
    expect(matches).toContainEqual({
      provider: 'spotify',
      name: 'Zulu Edition',
      creator: 'Spotify Artist',
      identifier: 'recorded-identifier',
    })
    expect(matches).toContainEqual({
      provider: 'musicbrainz',
      name: 'Release Group',
      creator: 'As Credited',
      identifier: null,
    })
    expect(matches).toContainEqual({
      provider: 'discogs',
      name: 'Master Release',
      creator: 'Discogs Credit',
      identifier: null,
    })
    expect(matches).toContainEqual({
      provider: 'lastfm',
      name: 'Last.fm Album',
      creator: 'Last.fm Artist',
      identifier: 'https://www.last.fm/music/Artist/Album',
    })
    expect(matches).toContainEqual({
      provider: 'serply',
      name: 'Indexed Album',
      creator: 'Indexed Artist',
      identifier: null,
    })
    const listening = matches?.filter(
      ({ provider }) => provider === 'lastfm-listening',
    )
    expect(listening).toHaveLength(2)
    expect(listening).toEqual(
      expect.arrayContaining([
        {
          provider: 'lastfm-listening',
          name: 'SCROBBLED ALBUM',
          creator: 'Scrobbled Artist',
          identifier: null,
          albumKey: 'scrobbled album',
          artistKey: 'scrobbled artist',
        },
        {
          provider: 'lastfm-listening',
          name: 'Scrobbled Album',
          creator: 'Scrobbled Artist',
          identifier: null,
          albumKey: 'scrobbled album',
          artistKey: 'scrobbled artist',
        },
      ]),
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('searches all observed names and sorts before applying limits', async () => {
    const sorted = await listMediaMatchDiagnostics(
      'album',
      MatchDiagnosticsQuerySchema.parse({ size: 1, sortBy: 'spotify' }),
    )
    expect(sorted.items.map(({ id }) => id)).toEqual(['album-two'])
    const filtered = await listMediaMatchDiagnostics(
      'album',
      MatchDiagnosticsQuerySchema.parse({ size: 1, q: 'Scrobbled Artist' }),
    )
    expect(filtered.items.map(({ id }) => id)).toEqual(['album-one'])
    const empty = await listMediaMatchDiagnostics(
      'album',
      MatchDiagnosticsQuerySchema.parse({
        size: 1,
        page: 2,
        q: 'Zulu Edition',
      }),
    )
    expect(empty).toMatchObject({ items: [], totalCount: 1, pageCount: 1 })
  })

  it('shows matched RYM and Metacritic identities from the raw and cleaned legacy imports', async () => {
    const result = await listMediaMatchDiagnostics(
      'album',
      MatchDiagnosticsQuerySchema.parse({ sortBy: 'google-custom-search' }),
    )
    expect(
      result.items.map(({ id, matches }) => ({
        id,
        matches: matches.filter(
          ({ provider }) => provider === 'google-custom-search',
        ),
      })),
    ).toEqual([
      {
        id: 'album-two',
        matches: [
          {
            provider: 'google-custom-search',
            sourceProvider: 'legacy-browser',
            name: 'Dawn Edition',
            creator: 'Other Source Artist',
            identifier:
              'https://rateyourmusic.com/release/album/fixture/edition/',
          },
          {
            provider: 'google-custom-search',
            name: 'A Standalone Metacritic Match',
            creator: null,
            identifier: 'https://www.metacritic.com/music/fixture/',
          },
        ],
      },
      {
        id: 'album-three',
        matches: [
          {
            provider: 'google-custom-search',
            name: null,
            creator: null,
            identifier:
              'https://rateyourmusic.com/release/album/fixture/link-only.p/reviews/1/',
          },
          {
            provider: 'google-custom-search',
            sourceProvider: 'legacy-browser',
            name: 'Archive Review',
            creator: 'Source Duo',
            identifier:
              'https://metacritic.com/music/archive-review/fixture/critic-reviews/',
          },
        ],
      },
      {
        id: 'album-four',
        matches: [
          {
            provider: 'google-custom-search',
            name: 'Morning Chronicle by Paper Trio Reviews and Tracks ...',
            creator: null,
            identifier:
              'https://www.metacritic.com/music/morning-chronicle/fixture/user-reviews/',
          },
        ],
      },
      {
        id: 'album-one',
        matches: [
          {
            provider: 'google-custom-search',
            name: 'Winter Record',
            creator: 'Source Artist',
            identifier:
              'https://rateyourmusic.com/release/album/fixture/record/',
          },
          {
            provider: 'google-custom-search',
            name: 'Autumn Review',
            creator: 'Recorded Artist',
            identifier:
              'https://www.metacritic.com/music/autumn-review/fixture/',
          },
        ],
      },
    ])
    const filtered = await listMediaMatchDiagnostics(
      'album',
      MatchDiagnosticsQuerySchema.parse({ q: 'Dawn Edition' }),
    )
    expect(filtered.items.map(({ id }) => id)).toEqual(['album-two'])
    const metacritic = await listMediaMatchDiagnostics(
      'album',
      MatchDiagnosticsQuerySchema.parse({ q: 'Autumn Review' }),
    )
    expect(metacritic.items.map(({ id }) => id)).toEqual(['album-one'])
    for (const q of [
      'Unrelated Metacritic Title',
      'Unrelated Movie Match',
      'Older Browser Metacritic Match',
    ]) {
      const unrelated = await listMediaMatchDiagnostics(
        'album',
        MatchDiagnosticsQuerySchema.parse({ q }),
      )
      expect(unrelated.items).toEqual([])
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses only directors for films and includes unmatched visible items', async () => {
    const result = await listMediaMatchDiagnostics(
      'film',
      MatchDiagnosticsQuerySchema.parse({}),
    )
    expect(result.providers).toContainEqual({
      key: 'sample-extension',
      label: 'sample-extension',
    })
    expect(result.items).toEqual([
      {
        id: 'film-one',
        name: 'The Library Film',
        creator: 'Library Director',
        matches: [
          {
            provider: 'sample-extension',
            name: 'Documented Film',
            creator: 'Extension Director',
            identifier: null,
          },
          {
            provider: 'tmdb',
            name: 'Localized Film',
            creator: 'TMDb Director',
            identifier: '10001',
          },
        ],
      },
      {
        id: 'film-without-evidence',
        name: 'Unmatched Film',
        creator: null,
        matches: [],
      },
    ])
    await expect(
      listMediaMatchDiagnostics(
        'film',
        MatchDiagnosticsQuerySchema.parse({ sortBy: 'irrelevant' }),
      ),
    ).rejects.toMatchObject({ response: { statusCode: 422 } })
  })
})

async function createAlbumFixture(id: string) {
  await databaseClient.insert(schema.mediaItem).values({
    id,
    slug: id,
    title: id,
    mediaType: 'album',
  })
  await databaseClient.insert(schema.album).values({ mediaItemId: id })
}

async function storeMatchFixture(
  mediaItemId: string,
  provider: string,
  snapshotId: string,
  payload: JsonValue,
  normalizedData: Record<string, JsonValue> | null = null,
) {
  const state = { payload, normalizedData, checksum: snapshotId }
  await databaseClient.insert(schema.providerSnapshot).values({
    ...state,
    id: snapshotId,
    mediaItemId,
    provider,
    source: 'fixture',
  })
  await databaseClient
    .insert(schema.providerCurrentState)
    .values({
      ...state,
      id: `${mediaItemId}:${provider}`,
      mediaItemId,
      provider,
      status: 'ready',
      latestSnapshotId: snapshotId,
    })
    .onConflictDoUpdate({
      target: [
        schema.providerCurrentState.mediaItemId,
        schema.providerCurrentState.provider,
      ],
      set: { ...state, latestSnapshotId: snapshotId },
    })
}

async function getFixtureMatches(id: string) {
  const result = await listMediaMatchDiagnostics(
    'album',
    MatchDiagnosticsQuerySchema.parse({ q: id }),
  )
  return result.items.find((row) => row.id === id)?.matches ?? []
}

describe('album match rejection history', () => {
  it('rejects native Discogs, MusicBrainz and Last.fm records without normalized references', async () => {
    const id = 'native-rejection-fixture'
    const groupId = '33ce6ab1-9cbd-4974-ab55-200911ac233f'
    const lastfmId = '0dc2c047-84c7-4f73-9654-a56bfa10751c'
    const lastfmUrl = 'https://www.last.fm/music/Fixture+Artist/Fixture+Album'
    await createAlbumFixture(id)
    const discogs = {
      master: { id: 4321, title: 'Native Master', main_release: 7654 },
      mainRelease: { id: 7654, title: 'Other Edition', master_id: 4321 },
    }
    const musicbrainz = { releaseGroup: { id: groupId, title: 'Native Group' } }
    const lastfm = {
      name: 'Native Last.fm Album',
      mbid: lastfmId,
      url: lastfmUrl,
    }
    await storeMatchFixture(id, 'discogs', 'native-master', discogs)
    await storeMatchFixture(id, 'musicbrainz', 'native-group', musicbrainz)
    await storeMatchFixture(id, 'lastfm', 'native-lastfm', lastfm)

    const matches = await getFixtureMatches(id)
    expect(
      matches.map(({ provider, identifier, rejectionTarget }) => [
        provider,
        identifier,
        rejectionTarget?.referenceType,
      ]),
    ).toEqual([
      ['discogs', '4321', 'master'],
      ['lastfm', lastfmUrl, 'url'],
      ['musicbrainz', groupId, 'release-group'],
    ])
    for (const match of matches) {
      if (!match.rejectionTarget) throw new Error('Missing fixture snapshot')
      await rejectAlbumMatch(id, match.rejectionTarget, null)
    }
    for (const [provider, referenceType, externalId] of [
      ['discogs', 'master', '4321'],
      ['musicbrainz', 'release-group', groupId],
      ['lastfm', 'mbid', lastfmId],
    ]) {
      const result = PluginResultSchema.parse({
        payload: {},
        normalized: {
          references: [{ referenceType, externalId, isPrimary: true }],
        },
      })
      if (!provider) throw new Error('Missing fixture provider')
      await expect(
        applyProviderResult({
          mediaItemId: id,
          mediaType: 'album',
          provider,
          source: 'scrape-job',
          ...result,
        }),
      ).rejects.toThrow('The album match was previously rejected.')
    }
    const replacement = PluginResultSchema.parse({
      payload: { release: { id: '4321', title: 'Distinct Release' } },
    })
    await applyProviderResult({
      mediaItemId: id,
      mediaType: 'album',
      provider: 'discogs',
      source: 'scrape-job',
      ...replacement,
    })
    await storeMatchFixture(id, 'lastfm', 'native-lastfm-url-only', {
      ...lastfm,
      mbid: 'unavailable',
    })
    await storeMatchFixture(id, 'musicbrainz', 'native-untyped', {
      id: groupId,
      title: 'Unidentified Entity',
    })
    const after = await getFixtureMatches(id)
    const discogsMatch = after.find(({ provider }) => provider === 'discogs')
    expect(discogsMatch).toMatchObject({
      name: 'Distinct Release',
      identifier: '4321',
      rejectionTarget: { referenceType: 'release' },
    })
    expect(discogsMatch?.rejectedAt).toBeUndefined()
    expect(after.find(({ provider }) => provider === 'lastfm')).toMatchObject({
      identifier: lastfmUrl,
      rejectionTarget: { referenceType: 'url' },
      rejectedAt: expect.any(String),
    })
    expect(
      after.find(({ provider }) => provider === 'musicbrainz'),
    ).toMatchObject({ identifier: null })
    expect(
      await getMediaSourceSnapshot(id, 'discogs', 'native-master'),
    ).toMatchObject({ data: discogs })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects one legacy identity once, preserves its shared snapshot, and marks equivalent URLs only on that album', async () => {
    const id = 'legacy-rejection-fixture'
    const other = 'neighbor-rejection-fixture'
    const provider = 'google-custom-search'
    const sourceProvider = 'legacy-record'
    const snapshotId = 'legacy-rejection-snapshot'
    const rym = 'https://rateyourmusic.com/release/album/fixture/rejectable/'
    const equivalentRym =
      'http://www.rateyourmusic.com/release/album/fixture/rejectable/reviews/2/'
    const metacritic = 'https://www.metacritic.com/music/separate/fixture/'
    const payload = {
      rymGoogle: {
        link: rym,
        rawResponse: { title: 'Wrong Release by Source Artist - RYM' },
      },
      metacriticGoogle: {
        link: metacritic,
        rawResponse: { title: 'Correct Release by Source Artist - Metacritic' },
      },
    }
    await createAlbumFixture(id)
    await createAlbumFixture(other)
    await storeMatchFixture(id, sourceProvider, snapshotId, payload)
    await storeMatchFixture(
      other,
      sourceProvider,
      'neighbor-rejection-snapshot',
      payload,
    )
    await storeMatchFixture(
      id,
      'serply',
      'serply-rejection-snapshot',
      {},
      {
        references: [
          {
            referenceType: 'rym-url',
            externalId: equivalentRym,
            isPrimary: true,
          },
        ],
      },
    )

    const before = await getFixtureMatches(id)
    const rymTarget = before.find(
      (match) => match.identifier === rym,
    )?.rejectionTarget
    const metacriticTarget = before.find(
      (match) => match.identifier === metacritic,
    )?.rejectionTarget
    expect(rymTarget).toEqual({
      provider,
      sourceProvider,
      snapshotId,
      referenceType: 'rym-url',
      identifier: rym,
    })
    expect(metacriticTarget).toEqual({
      provider,
      sourceProvider,
      snapshotId,
      referenceType: 'metacritic-url',
      identifier: metacritic,
    })
    if (!rymTarget || !metacriticTarget)
      throw new Error('Missing fixture evidence')

    await expect(
      rejectAlbumMatch(
        id,
        { ...rymTarget, sourceProvider: 'legacy-browser' },
        null,
      ),
    ).rejects.toMatchObject({ response: { statusCode: 409 } })
    await expect(
      rejectAlbumMatch(
        id,
        { ...rymTarget, referenceType: 'metacritic-url' },
        null,
      ),
    ).rejects.toMatchObject({ response: { statusCode: 409 } })
    const [first, duplicate] = await Promise.all([
      rejectAlbumMatch(id, rymTarget, null),
      rejectAlbumMatch(id, rymTarget, null),
    ])
    expect(duplicate).toEqual(first)

    const after = await getFixtureMatches(id)
    expect(after.find((match) => match.identifier === rym)?.rejectedAt).toBe(
      first.rejectedAt,
    )
    expect(
      after.find((match) => match.identifier === equivalentRym)?.rejectedAt,
    ).toBe(first.rejectedAt)
    expect(
      after.find((match) => match.identifier === metacritic)?.rejectedAt,
    ).toBeUndefined()
    expect(
      (await getFixtureMatches(other)).find((match) => match.identifier === rym)
        ?.rejectedAt,
    ).toBeUndefined()
    expect(
      await getMediaSourceSnapshot(id, sourceProvider, snapshotId),
    ).toMatchObject({ data: payload })
    expect((await getMediaHistory(id)).events).toContainEqual(
      expect.objectContaining({
        title: 'Album match rejected',
        provider,
        data: rymTarget,
      }),
    )
    expect(await listAlbumMatchRejections(id, { page: 1, size: 5 })).toEqual({
      items: [first],
      page: 1,
      size: 5,
      pageCount: 1,
      totalCount: 1,
    })

    await rejectAlbumMatch(id, metacriticTarget, null)
    expect(
      await listAlbumMatchRejections(id, { page: 2, size: 1 }),
    ).toMatchObject({
      items: [first],
      pageCount: 2,
      totalCount: 2,
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects stale source evidence, distinguishes Discogs master from release, and retains the original decision after replacement', async () => {
    const id = 'discogs-rejection-fixture'
    const provider = 'discogs'
    await createAlbumFixture(id)
    const releaseId = '1234'
    const master = {
      referenceType: 'master',
      externalId: releaseId,
      isPrimary: true,
    }
    const release = {
      referenceType: 'release',
      externalId: releaseId,
      isPrimary: true,
    }
    await storeMatchFixture(
      id,
      provider,
      'discogs-initial',
      { master: { title: 'Initial Master' } },
      { references: [master] },
    )
    const [initial] = await getFixtureMatches(id)
    if (!initial?.rejectionTarget) throw new Error('Missing fixture evidence')

    await storeMatchFixture(
      id,
      provider,
      'discogs-current',
      { master: { title: 'Current Master' } },
      { references: [master] },
    )
    await expect(
      rejectAlbumMatch(id, initial.rejectionTarget, null),
    ).rejects.toMatchObject({ response: { statusCode: 409 } })
    const [current] = await getFixtureMatches(id)
    if (!current?.rejectionTarget) throw new Error('Missing fixture evidence')
    const rejected = await rejectAlbumMatch(id, current.rejectionTarget, null)
    expect(await readAlbumMatchRejections(databaseClient, id)).toEqual([
      {
        ...rejected,
        aliases: [
          {
            referenceType: 'url',
            externalId: `https://www.discogs.com/master/${releaseId}`,
          },
        ],
      },
    ])

    const replacement = { release: { title: 'Replacement Release' } }
    await storeMatchFixture(id, provider, 'discogs-replacement', replacement, {
      references: [release],
    })
    const [latest] = await getFixtureMatches(id)
    expect(latest).toMatchObject({
      name: 'Replacement Release',
      rejectionTarget: {
        referenceType: 'release',
        snapshotId: 'discogs-replacement',
      },
    })
    expect(latest?.rejectedAt).toBeUndefined()
    expect(await rejectAlbumMatch(id, current.rejectionTarget, null)).toEqual(
      rejected,
    )
    expect(
      await listAlbumMatchRejections(id, { page: 1, size: 5 }),
    ).toMatchObject({ items: [rejected], totalCount: 1 })
    expect(
      await getMediaSourceSnapshot(id, provider, 'discogs-current'),
    ).toMatchObject({ data: { master: { title: 'Current Master' } } })
    expect(
      await getMediaSourceSnapshot(id, provider, 'discogs-replacement'),
    ).toMatchObject({ data: replacement })
    await expect(
      rejectAlbumMatch('film-one', current.rejectionTarget, null),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
    await expect(
      listAlbumMatchRejections('film-one', { page: 1, size: 5 }),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses a corroborated URL alias and leaves query-dependent identities ineligible for rejection by display URL', async () => {
    const id = 'extension-rejection-fixture'
    const provider = 'sample-extension'
    const identifier = 'release-fixture'
    const releaseUrl = 'https://catalog.example.test/album/fixture'
    await createAlbumFixture(id)
    await storeMatchFixture(
      id,
      provider,
      'extension-initial',
      {},
      {
        references: [
          { referenceType: 'album', externalId: identifier, isPrimary: true },
        ],
        links: [
          {
            provider,
            label: 'Fixture Album',
            url: `${releaseUrl}?utm_source=test`,
          },
        ],
      },
    )
    const [initial] = await getFixtureMatches(id)
    if (!initial?.rejectionTarget) throw new Error('Missing fixture evidence')
    const rejected = await rejectAlbumMatch(id, initial.rejectionTarget, null)
    expect(await readAlbumMatchRejections(databaseClient, id)).toEqual([
      {
        ...rejected,
        aliases: [{ referenceType: 'url', externalId: releaseUrl }],
      },
    ])

    await storeMatchFixture(
      id,
      provider,
      'extension-query',
      {},
      {
        references: [
          {
            referenceType: 'url',
            externalId: `${releaseUrl}?edition=fixture`,
            isPrimary: true,
          },
        ],
      },
    )
    const [queryMatch] = await getFixtureMatches(id)
    expect(queryMatch).toMatchObject({ identifier: releaseUrl })
    expect(queryMatch?.rejectionTarget).toBeUndefined()
    expect(queryMatch?.rejectedAt).toBeUndefined()
    await expect(
      rejectAlbumMatch(
        id,
        {
          provider,
          sourceProvider: provider,
          snapshotId: 'extension-query',
          referenceType: 'url',
          identifier: releaseUrl,
        },
        null,
      ),
    ).rejects.toMatchObject({ response: { statusCode: 409 } })
    expect(fetch).not.toHaveBeenCalled()
  })
})
