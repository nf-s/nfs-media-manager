import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { createMiddleware } from 'hono/factory'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PluginResultSchema, type JsonValue } from '@repo/media-plugin-sdk'
import {
  AlbumMatchRejectionInputSchema,
  AlbumMatchRejectionPageSchema,
  AlbumMatchRejectionSchema,
  AlbumMetacriticCandidatesInputSchema,
  AlbumMetacriticCorrectionInputSchema,
  MatchDiagnosticsPageSchema,
  MatchDiagnosticsQuerySchema,
} from '@repo/schemas/match-diagnostics'
import { AlbumQuerySchema } from '@repo/schemas/media'
import { env } from '@/env'
import { createAlbumMatchRejectionPredicate } from '@/lib/album-match-identities'
import albumsApi from '@/routes/albums'
import { getBuiltinProviderCatalog } from '@/lib/provider-catalog'
import * as schema from '@/schemas/db'
import {
  albumMatchRejectionField,
  listAlbumMatchRejections,
  readAlbumMatchRejections,
  rejectAlbumMatch,
} from '@/services/album-match-rejections'
import {
  correctAlbumMetacriticMatch,
  searchAlbumMetacriticCandidates,
} from '@/services/album-metacritic-corrections'
import {
  getMediaHistory,
  getMediaSourceSnapshot,
  getMediaSources,
} from '@/services/history'
import { getAlbumDetail, listAlbums } from '@/services/media'
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
vi.mock('@/middlewares/auth', () => ({
  authMiddleware: () => createMiddleware(async (_context, next) => next()),
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

  it('displays catalog album credits only for the selected record', async () => {
    const id = 'catalog-diagnostics-fixture'
    const provider = 'sample-extension'
    const reference = {
      referenceType: 'catalog-release',
      externalId: '42',
      isPrimary: true,
    }
    const payload = {
      id: '42',
      title: 'Recorded Catalog Edition',
      artists: ['First Credit', { name: 'Second Credit' }],
    }
    await createAlbumFixture(id)
    await storeMatchFixture(id, provider, 'catalog-selected', payload, {
      references: [reference],
    })
    expect(await getFixtureMatches(id)).toContainEqual(
      expect.objectContaining({
        provider,
        identifier: '42',
        name: 'Recorded Catalog Edition',
        creator: 'First Credit, Second Credit',
      }),
    )

    const search = await listMediaMatchDiagnostics(
      'album',
      MatchDiagnosticsQuerySchema.parse({ q: 'Second Credit' }),
    )
    expect(search.items.map((row) => row.id)).toEqual([id])

    await storeMatchFixture(id, provider, 'catalog-different-record', payload, {
      references: [{ ...reference, externalId: '43' }],
    })
    expect(await getFixtureMatches(id)).toContainEqual(
      expect.objectContaining({
        provider,
        identifier: '43',
        name: null,
        creator: null,
      }),
    )
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
  it('archives a rejected Metacritic rating and records an evidence-backed replacement', async () => {
    const id = 'verified-metacritic-fixture'
    const oldUrl = 'https://www.metacritic.com/music/wrong-record/fixture'
    const url =
      'https://www.metacritic.com/music/verified-record/fixture/critic-reviews'
    const rymUrl = 'https://rateyourmusic.com/release/album/fixture/record/'
    const legacyProvider = 'google-custom-search'
    const oldPayload = {
      metacriticGoogle: { link: oldUrl, rating: { value: 99, votes: 15 } },
      rymGoogle: { link: rymUrl },
    }
    await createAlbumFixture(id)
    await applyProviderResult({
      mediaItemId: id,
      mediaType: 'album',
      provider: legacyProvider,
      source: 'legacy-fixture',
      payload: oldPayload,
      normalized: PluginResultSchema.parse({
        payload: oldPayload,
        normalized: {
          mediaPatch: {
            metadata: {
              browse: {
                ratingMetacriticValue: 99,
                ratingMetacriticVotes: 15,
                ratingRymValue: 3,
              },
            },
          },
          links: [
            { provider: legacyProvider, label: 'Metacritic', url: oldUrl },
            { provider: legacyProvider, label: 'Rate Your Music', url: rymUrl },
          ],
        },
      }).normalized,
    })
    const original = (await getFixtureMatches(id)).find(
      ({ identifier }) => identifier === oldUrl,
    )?.rejectionTarget
    if (!original) throw new Error('Missing fixture evidence')
    const correction = AlbumMetacriticCorrectionInputSchema.parse({
      rejected: original,
      replacement: { url, title: 'Verified Record', artist: 'Fixture Artist' },
      evidence: [
        {
          source: 'wikidata',
          sourceUrl: 'https://www.wikidata.org/wiki/Q42',
          observedUrl: url,
          observedAt: '2025-02-03T04:05:06Z',
        },
      ],
    })
    await expect(
      correctAlbumMetacriticMatch(id, correction, null),
    ).rejects.toMatchObject({ response: { statusCode: 409 } })
    expect((await getAlbumDetail(id))?.links.map((link) => link.url)).toContain(
      oldUrl,
    )
    const rated = AlbumQuerySchema.parse({
      q: id,
      ranges: [{ field: 'ratingMetacriticValue', min: 90 }],
    })
    expect((await listAlbums(rated)).items.map((item) => item.id)).toEqual([id])
    await rejectAlbumMatch(id, original, null)
    expect((await listAlbums(rated)).items).toEqual([])
    expect(await getAlbumDetail(id)).toMatchObject({
      links: [{ url: rymUrl }],
      metadata: {
        browse: {
          ratingMetacriticValue: null,
          ratingMetacriticVotes: null,
          ratingRymValue: 3,
        },
      },
    })
    const page = await listAlbums(AlbumQuerySchema.parse({ q: id }))
    expect(page.items.find((item) => item.id === id)).toMatchObject({
      links: [{ url: rymUrl }],
      metadata: {
        browse: {
          ratingMetacriticValue: null,
          ratingMetacriticVotes: null,
          ratingRymValue: 3,
        },
      },
    })
    await expect(
      correctAlbumMetacriticMatch(
        id,
        {
          ...correction,
          rejected: {
            ...correction.rejected,
            sourceProvider: 'legacy-browser',
          },
        },
        null,
      ),
    ).rejects.toMatchObject({ response: { statusCode: 409 } })
    await expect(
      correctAlbumMetacriticMatch(
        id,
        {
          ...correction,
          rejected: { ...correction.rejected, snapshotId: 'unrelated-fixture' },
        },
        null,
      ),
    ).rejects.toMatchObject({ response: { statusCode: 409 } })
    const replacementUrl = `${oldUrl}/user-reviews`
    await expect(
      correctAlbumMetacriticMatch(
        id,
        {
          ...correction,
          replacement: { ...correction.replacement, url: replacementUrl },
          evidence: correction.evidence.map((evidence) => ({
            ...evidence,
            observedUrl: replacementUrl,
          })),
        },
        null,
      ),
    ).rejects.toMatchObject({ response: { statusCode: 409 } })

    const [saved, replay] = await Promise.all([
      correctAlbumMetacriticMatch(id, correction, null),
      correctAlbumMetacriticMatch(id, correction, null),
    ])
    expect(replay).toEqual(saved)
    expect(
      (await getMediaHistory(id)).events.filter(
        ({ title }) => title === 'Metacritic album match corrected',
      ),
    ).toHaveLength(1)
    expect(await getAlbumDetail(id)).toMatchObject({
      links: expect.arrayContaining([
        { provider: 'metacritic', label: 'Metacritic', url },
        expect.objectContaining({ url: rymUrl }),
      ]),
      metadata: {
        browse: {
          ratingMetacriticValue: null,
          ratingMetacriticVotes: null,
          ratingRymValue: 3,
        },
      },
    })
    expect(
      (await getAlbumDetail(id))?.links.map((link) => link.url),
    ).not.toContain(oldUrl)
    expect(await getFixtureMatches(id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: legacyProvider,
          identifier: oldUrl,
          rejectedAt: expect.any(String),
        }),
        expect.objectContaining({
          provider: 'metacritic',
          identifier: url,
          name: 'Verified Record',
          creator: 'Fixture Artist',
        }),
      ]),
    )
    expect((await getMediaSources(id)).providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: legacyProvider,
          latestSnapshot: expect.objectContaining({ id: original.snapshotId }),
        }),
        expect.objectContaining({
          id: 'metacritic',
          latestSnapshot: expect.objectContaining({ id: saved.snapshotId }),
        }),
      ]),
    )
    expect(
      await getMediaSourceSnapshot(
        id,
        original.sourceProvider,
        original.snapshotId,
      ),
    ).toMatchObject({ data: oldPayload })
    expect(
      await getMediaSourceSnapshot(id, 'metacritic', saved.snapshotId),
    ).toMatchObject({ data: correction })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('finds cleaned Metacritic matches under either key while keeping the selected URL and source', async () => {
    const id = 'cleaned-metacritic-fixture'
    const rawUrl = 'https://metacritic.com/music/raw-record/fixture/'
    const preferredUrl = 'https://metacritic.com/music/cleaned-record/fixture/'
    const alternateUrl =
      'https://metacritic.com/music/alternate-record/fixture/'
    const alternateTitle = 'Alternate Record by Fixture Artist - Metacritic'
    await createAlbumFixture(id)
    await storeMatchFixture(id, 'legacy-browser', 'cleaned-metacritic', {
      links: {
        metacritic: {
          href: 'https://metacritic.com.example.test/music/fixture/',
          title: 'Wrong host',
        },
        mc: { href: alternateUrl, title: alternateTitle },
      },
    })
    expect(await getFixtureMatches(id)).toContainEqual(
      expect.objectContaining({
        name: 'Alternate Record',
        creator: 'Fixture Artist',
        rejectionTarget: {
          provider: 'google-custom-search',
          sourceProvider: 'legacy-browser',
          snapshotId: 'cleaned-metacritic',
          referenceType: 'metacritic-url',
          identifier: alternateUrl,
        },
      }),
    )

    await storeMatchFixture(
      id,
      'legacy-browser',
      'preferred-cleaned-metacritic',
      {
        links: {
          metacritic: { href: preferredUrl },
          mc: { href: alternateUrl, title: alternateTitle },
        },
      },
    )
    expect(await getFixtureMatches(id)).toContainEqual(
      expect.objectContaining({
        identifier: preferredUrl,
        name: null,
        creator: null,
      }),
    )

    await storeMatchFixture(id, 'google-custom-search', 'raw-metacritic', {
      metacriticGoogle: { link: rawUrl },
    })
    expect(await getFixtureMatches(id)).toContainEqual(
      expect.objectContaining({
        identifier: rawUrl,
        name: null,
        creator: null,
        rejectionTarget: expect.objectContaining({
          sourceProvider: 'google-custom-search',
          snapshotId: 'raw-metacritic',
        }),
      }),
    )

    await storeMatchFixture(id, 'legacy-browser', 'same-cleaned-metacritic', {
      links: {
        metacritic: { href: preferredUrl },
        mc: {
          href: rawUrl,
          title: 'Raw Record by Fixture Artist - Metacritic',
        },
      },
    })
    const matches = await getFixtureMatches(id)
    expect(matches).toContainEqual(
      expect.objectContaining({
        identifier: rawUrl,
        name: 'Raw Record',
        creator: 'Fixture Artist',
        rejectionTarget: expect.objectContaining({
          sourceProvider: 'legacy-browser',
          snapshotId: 'same-cleaned-metacritic',
        }),
      }),
    )
    const target = matches.find(
      (match) => match.identifier === rawUrl,
    )?.rejectionTarget
    if (!target) throw new Error('Missing fixture evidence')
    const decision = await rejectAlbumMatch(id, target, null)

    const reviewUrl = `${rawUrl}critic-reviews/`
    await storeMatchFixture(id, 'google-custom-search', 'raw-critic-reviews', {
      metacriticGoogle: { link: reviewUrl },
    })
    expect(await getFixtureMatches(id)).toContainEqual(
      expect.objectContaining({
        identifier: reviewUrl,
        rejectedAt: decision.rejectedAt,
      }),
    )
    expect(
      await listAlbumMatchRejections(id, { page: 1, size: 5 }),
    ).toMatchObject({ items: [decision] })
    expect(fetch).not.toHaveBeenCalled()
  })

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

  it('keeps a long multibyte legacy RYM release visible with exact rejection history', async () => {
    const id = 'long-rym-release-fixture'
    const prefix = 'https://rateyourmusic.com/release/album/fixture/'
    const slug = `${'音楽'.repeat(65)}%2Ffixture`
    const raw = `${prefix}${encodeURIComponent('音楽'.repeat(65))}%2Ffixture/`
    const title = 'Long Release by Fixture Artist - RYM'
    const endpoint = `/${id}/match-rejections`
    const source = {
      rymGoogle: {
        link: `${raw}?utm_source=fixture#overview`,
        rawResponse: { title },
      },
      metacriticGoogle: {
        link: 'https://www.metacritic.com/music/fixture/',
        rawResponse: { title: 'Other Release by Fixture Artist - Metacritic' },
      },
    }
    await createAlbumFixture(id)
    await storeMatchFixture(
      id,
      'google-custom-search',
      'long-rym-original',
      source,
    )
    const oldView = await albumsApi.request(`/match-diagnostics?q=${id}`)
    expect(oldView.status).toBe(200)
    const diagnosticsResponse = z.object({ data: MatchDiagnosticsPageSchema })
    const historyResponse = z.object({ data: AlbumMatchRejectionPageSchema })
    const oldMatches = diagnosticsResponse.parse(await oldView.json()).data
      .items[0]?.matches
    const oldCell = oldMatches?.find(({ identifier }) => identifier === raw)
    expect(oldCell).toMatchObject({
      name: 'Long Release',
      creator: 'Fixture Artist',
    })
    expect(oldCell?.rejectionTarget).toBeUndefined()

    const view = await albumsApi.request(`/match-diagnostics?q=${id}&longRym=1`)
    expect(view.status).toBe(200)
    const matches = diagnosticsResponse.parse(await view.json()).data.items[0]
      ?.matches
    const match = matches?.find(({ identifier }) => identifier === raw)
    const target = AlbumMatchRejectionInputSchema.parse(match?.rejectionTarget)
    expect(target).toEqual({
      provider: 'google-custom-search',
      sourceProvider: 'google-custom-search',
      snapshotId: 'long-rym-original',
      referenceType: 'rym-url',
      identifier: raw,
    })

    await expect(
      rejectAlbumMatch(
        id,
        { ...target, identifier: `${prefix}${slug}/` },
        null,
      ),
    ).rejects.toMatchObject({ response: { statusCode: 409 } })
    const ordinary = (await getFixtureMatches(id)).find(
      ({ rejectionTarget }) =>
        rejectionTarget?.referenceType === 'metacritic-url',
    )?.rejectionTarget
    if (!ordinary) throw new Error('Missing ordinary fixture match.')
    const ordinaryDecision = await rejectAlbumMatch(id, ordinary, null)
    const saved = await albumsApi.request(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(target),
    })
    expect(saved.status).toBe(200)
    const decision = z
      .object({ data: AlbumMatchRejectionSchema })
      .parse(await saved.json()).data
    expect(decision).toMatchObject(target)
    const updatedHistory = await albumsApi.request(
      `${endpoint}?size=1&longRym=1`,
    )
    expect(updatedHistory.status).toBe(200)
    expect(
      historyResponse.parse(await updatedHistory.json()).data,
    ).toMatchObject({
      items: [decision],
      totalCount: 2,
      pageCount: 2,
    })
    const oldHistory = await albumsApi.request(`${endpoint}?size=1`)
    expect(oldHistory.status).toBe(200)
    expect(historyResponse.parse(await oldHistory.json()).data).toMatchObject({
      items: [ordinaryDecision],
      totalCount: 1,
      pageCount: 1,
    })
    expect((await getMediaHistory(id)).events).toContainEqual(
      expect.objectContaining({ title: 'Album match rejected', data: target }),
    )
    expect(
      await getMediaSourceSnapshot(
        id,
        'google-custom-search',
        'long-rym-original',
      ),
    ).toMatchObject({ data: source })

    const rejects = createAlbumMatchRejectionPredicate('serply', [
      { ...target, aliases: [] },
    ])
    const identity = (externalId: string) => ({
      referenceType: 'rym-url',
      externalId,
    })
    const unicode = `${prefix}${slug}/`.replace('%2F', '%2f')
    expect(
      rejects(identity(`${unicode}reviews/2/?utm_campaign=fixture#start`)),
    ).toBe(true)
    expect(rejects(identity(`${unicode}?edition=separate`))).toBe(false)
    expect(rejects(identity(unicode.replace('%2f', '%252f')))).toBe(false)
    expect(rejects(identity(unicode.replace('%2f', '-')))).toBe(false)

    await storeMatchFixture(id, 'google-custom-search', 'long-rym-unicode', {
      rymGoogle: { link: unicode, rawResponse: { title } },
    })
    expect(await getFixtureMatches(id)).toContainEqual(
      expect.objectContaining({
        identifier: unicode,
        rejectedAt: decision.rejectedAt,
      }),
    )
    await databaseClient.insert(schema.mediaOverride).values({
      id: 'invalid-long-rym-rejection-source',
      mediaItemId: id,
      field: albumMatchRejectionField,
      value: { ...target, sourceProvider: 'serply' },
    })
    expect(await readAlbumMatchRejections(databaseClient, id)).toEqual([
      { ...decision, aliases: [] },
      { ...ordinaryDecision, aliases: [] },
    ])
    expect(
      (await listAlbumMatchRejections(id, { page: 1, size: 5, longRym: '1' }))
        .items,
    ).toEqual([decision, ordinaryDecision])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads a full RYM page heading only from the selected archived result', async () => {
    const id = 'archived-rym-page-title'
    const link = 'https://rateyourmusic.com/release/album/fixture/full-record/'
    const snippetTitle = 'Short result'
    const fullHeading = 'The Complete Record by Source Artist - RYM/Sonemic'
    await createAlbumFixture(id)
    async function store(
      snapshotId: string,
      resultLink: string,
      heading: string,
      title = snippetTitle,
    ) {
      await storeMatchFixture(id, 'google-custom-search', snapshotId, {
        rymGoogle: {
          link,
          rawResponse: {
            title,
            link: resultLink,
            pagemap: { metatags: [{ 'og:title': heading }] },
          },
        },
      })
    }
    await store('matching-header', link, fullHeading)
    expect(await getFixtureMatches(id)).toContainEqual(
      expect.objectContaining({
        identifier: link,
        name: 'The Complete Record',
        creator: 'Source Artist',
        rejectionTarget: expect.objectContaining({
          snapshotId: 'matching-header',
        }),
      }),
    )

    await store(
      'primary-heading',
      link,
      fullHeading,
      'Selected Title by Selected Artist - RYM',
    )
    expect(await getFixtureMatches(id)).toContainEqual(
      expect.objectContaining({
        identifier: link,
        name: 'Selected Title',
        creator: 'Selected Artist',
      }),
    )

    for (const [snapshotId, resultLink, heading] of [
      ['different-page', link + 'other/', fullHeading],
      [
        'ambiguous-artist',
        link,
        'A Track by Track Album by Source Artist - RYM/Sonemic',
      ],
      [
        'incomplete-header',
        link,
        'The Complete… by Source Artist - RYM/Sonemic',
      ],
    ]) {
      await store(snapshotId, resultLink, heading)
      expect(await getFixtureMatches(id)).toContainEqual(
        expect.objectContaining({
          identifier: link,
          name: snippetTitle,
          creator: null,
        }),
      )
    }
  })

  it('keeps long URL allowances within validated legacy RYM release scope', async () => {
    const prefix = 'https://rateyourmusic.com/release/album/fixture/'
    const slug = encodeURIComponent('音楽'.repeat(65))
    const identifier = `${prefix}${slug}/`
    const target = {
      provider: 'google-custom-search',
      sourceProvider: 'legacy-record',
      snapshotId: 'scoped-rejection-fixture',
      referenceType: 'rym-url',
      identifier,
    }
    for (const field of [
      { provider: 'lastfm' },
      { sourceProvider: 'serply' },
      { referenceType: 'metacritic-url' },
      { identifier: 'x'.repeat(501) },
      { identifier: `${prefix}${encodeURIComponent('音楽'.repeat(120))}/` },
      { identifier: identifier.replace('rateyourmusic.com', 'fixture.test') },
      { identifier: identifier.replace('fixture/', 'fixture/%2e%2e/') },
      { identifier: `${identifier}?edition=separate` },
      { identifier: `${identifier}unknown-tab/` },
    ]) {
      expect(
        AlbumMatchRejectionInputSchema.safeParse({ ...target, ...field })
          .success,
      ).toBe(false)
    }
    const fixtures = [
      `${identifier}?edition=separate`,
      `${prefix}${'音楽'.repeat(120)}/`,
      `https://fixture.test/release/album/fixture/${slug}/`,
      identifier.replace('fixture/', 'fixture/%2e%2e/'),
      `${identifier}unknown-tab/`,
    ]
    for (const [index, link] of fixtures.entries()) {
      const id = `long-rym-invalid-fixture-${index}`
      await createAlbumFixture(id)
      await storeMatchFixture(
        id,
        'legacy-record',
        `long-rym-invalid-source-${index}`,
        {
          rymGoogle: {
            link,
            rawResponse: { title: 'Other Release by Fixture Artist - RYM' },
          },
        },
      )
      expect(await getFixtureMatches(id)).toEqual([])
    }
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

  it('reads one indexed Metacritic page only for the still-unresolved rejection', async () => {
    const id = 'metacritic-search-fixture'
    const oldUrl = 'https://www.metacritic.com/music/rejected-record/fixture/'
    const url = 'https://metacritic.com/music/candidate-record/fixture/'
    const key = 'offline-metacritic-fixture-key'
    await createAlbumFixture(id)
    await databaseClient.insert(schema.mediaCredit).values({
      mediaItemId: id,
      artistId: 'library-artist',
      role: 'artist',
    })
    await storeMatchFixture(id, 'legacy-browser', 'archived-search-fixture', {
      links: { mc: { href: oldUrl } },
    })
    const target = (await getFixtureMatches(id)).find(
      ({ identifier }) => identifier === oldUrl,
    )?.rejectionTarget
    const input = AlbumMetacriticCandidatesInputSchema.parse({
      rejected: target,
    })
    fetch.mockClear()
    vi.stubEnv('SERPLY_API_KEY', key)
    try {
      await expect(
        searchAlbumMetacriticCandidates(id, input),
      ).rejects.toMatchObject({
        response: { statusCode: 409 },
      })
      expect(fetch).not.toHaveBeenCalled()
      await rejectAlbumMatch(id, input.rejected, null)
      await expect(
        searchAlbumMetacriticCandidates(id, {
          rejected: { ...input.rejected, snapshotId: 'different-archive' },
        }),
      ).rejects.toMatchObject({ response: { statusCode: 409 } })
      expect(fetch).not.toHaveBeenCalled()
      const history = await getMediaHistory(id)
      const sources = await getMediaSources(id)
      const found = {
        link: url,
        title: 'Fixture Candidate - Metacritic',
        description: 'Indexed album summary. ' + key,
        metadata: { published_time: 'May 20, 2022' },
      }
      const visible = Array.from({ length: 8 }, (_, index) => ({
        title: 'Indexed Fixture Candidate',
        link: 'https://www.metacritic.com/music/fixture-choice-' + index,
      }))
      fetch.mockImplementationOnce(async (request, init) => {
        const requested = new URL(
          request instanceof Request ? request.url : request,
        )
        expect(requested.origin).toBe('https://api.serply.io')
        expect(requested.pathname).toBe('/v1/search/')
        expect(requested.searchParams.get('q')).toBe(
          'site:metacritic.com/music/ "metacritic-search-fixture" "Library Artist"',
        )
        expect(requested.searchParams.get('num')).toBe('10')
        expect(new Headers(init?.headers).get('X-Api-Key')).toBe(key)
        return Response.json({
          results: [
            {
              link: 'http://metacritic.com/music/rejected-record/fixture/user-reviews',
              title: 'Rejected alias',
            },
            {
              link: 'https://metacritic.com.fixture.test/music/candidate-record',
              title: 'Unrelated domain',
            },
            {
              link: 'https://www.metacritic.com/movie/fixture',
              title: 'Unrelated media type',
            },
            found,
            ...visible,
          ],
        })
      })
      expect(await searchAlbumMetacriticCandidates(id, input)).toEqual({
        items: [
          {
            url,
            title: found.title,
            description: 'Indexed album summary. [REDACTED]',
            indexedDate: '2022-05-20',
          },
          ...visible.slice(0, 6).map(({ title, link }) => ({
            title,
            url: link,
            description: '',
          })),
        ],
      })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(await getMediaHistory(id)).toEqual(history)
      expect(await getMediaSources(id)).toEqual(sources)
      const correction = AlbumMetacriticCorrectionInputSchema.parse({
        rejected: target,
        replacement: {
          url,
          title: 'Fixture Candidate',
          artist: 'Library Artist',
        },
        evidence: [
          {
            source: 'metacritic-index',
            sourceUrl: url,
            observedUrl: url,
            observedAt: '2025-02-03T04:05:06Z',
          },
        ],
      })
      fetch.mockImplementationOnce(async () => {
        await correctAlbumMetacriticMatch(id, correction, null)
        return Response.json({ results: [found] })
      })
      await expect(
        searchAlbumMetacriticCandidates(id, input),
      ).rejects.toMatchObject({
        response: { statusCode: 409 },
      })
      await expect(
        searchAlbumMetacriticCandidates(id, input),
      ).rejects.toMatchObject({
        response: { statusCode: 409 },
      })
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
