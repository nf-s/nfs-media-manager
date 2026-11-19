import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MatchDiagnosticsQuerySchema } from '@repo/schemas/match-diagnostics'
import { env } from '@/env'
import { getBuiltinProviderCatalog } from '@/lib/provider-catalog'
import * as schema from '@/schemas/db'
import { listMediaMatchDiagnostics } from '@/services/media-match-diagnostics'

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
