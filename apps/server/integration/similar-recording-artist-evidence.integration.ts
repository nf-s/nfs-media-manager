import { randomUUID } from 'node:crypto'
import { asc, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { SpotifyCodeMatch, TidalSuggestion } from '@repo/schemas/tidal'
import { env } from '@/env'
import { createStableId } from '@/lib/media-utils'
import * as schema from '@/schemas/db'

const database = 'similar_artist_evidence_' + randomUUID().replaceAll('-', '')
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const fixture = drizzle(pool, { schema })

vi.mock('@/lib/db', () => ({
  get db() {
    return fixture
  },
}))

import {
  reconcileSimilarArtistCredits,
  repairStoredSimilarArtists,
} from '@/services/catalog-artist-reconciliation'
import { observeCatalogMedia } from '@/services/catalog-discoveries'
import { observeTidalSuggestion } from '@/services/music-catalog-observations'
import { storeSpotifyCodeLookup } from '@/services/spotify-similar-lookup'
import { mergeArtists } from '@/services/artist-merges'
import { undoLibraryChange } from '@/services/library-changes'
import { backfillTidalSimilarDiscoveries } from '@/services/tidal-similar'
import * as storedPages from '@/services/stored-tidal-similar-pages'

const seedId = 'fixture-recommendation-seed'
const jobId = 'fixture-recording-lookup'
const code = 'USZZZ2600100'
const title = 'Fixture Collaboration'
const spotifyId = 'S'.repeat(22)
const tidalCredits = [
  { id: '301', name: 'Fixture Cobalt' },
  { id: '302', name: 'Fixture Indigo' },
]
const spotifyCredits = [
  { id: 'P'.repeat(22), name: 'Fixture Indigo' },
  { id: 'Q'.repeat(22), name: 'Fixture Cobalt' },
]

const suggestion: TidalSuggestion = {
  title,
  version: null,
  artists: tidalCredits.map(({ name }) => name),
  artistCredits: tidalCredits,
  tidalId: '987654',
  durationSec: 200,
  code,
  releaseDate: null,
  url: 'https://tidal.com/track/987654',
}
const match: SpotifyCodeMatch = {
  spotifyId,
  title,
  artists: spotifyCredits.map(({ name }) => name),
  artistCredits: spotifyCredits,
  durationSec: 201,
  url: 'https://open.spotify.com/track/' + spotifyId,
  albumName: null,
  spotifyAlbumId: null,
  artworkUrl: null,
  trackCount: null,
}

const artistId = (provider: string, id: string) =>
  createStableId('catalog-artist', JSON.stringify([provider, id]))

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', async () => {
    throw new Error('Unexpected provider request')
  })
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(fixture, { migrationsFolder: './drizzle' })
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
})

beforeEach(async () => {
  await fixture.execute(
    sql`truncate library_change, artist, scrape_job, spotify_code_lookup, media_item cascade`,
  )
  await fixture.insert(schema.mediaItem).values({
    id: seedId,
    slug: seedId,
    title: 'Fixture Seed',
    mediaType: 'track',
  })
  await fixture.insert(schema.scrapeJob).values({
    id: jobId,
    status: 'succeeded',
    provider: 'spotify',
    scope: {},
    options: {},
  })
  await fixture.insert(schema.artist).values(
    spotifyCredits.map(({ id, name }) => ({
      id: artistId('spotify', id),
      name,
      catalogProvider: 'spotify',
      catalogExternalId: id,
    })),
  )
})

async function saveTidalPage(item = suggestion, pageId = seedId) {
  return fixture.transaction(async (tx) => {
    const track = await observeTidalSuggestion(tx, 'track', item, {
      operation: 'similar',
      key: pageId,
      position: 1,
    })
    await tx.insert(schema.tidalSimilar).values({
      mediaItemId: pageId,
      kind: 'track',
      items: [item],
      readAt: new Date(),
    })
    return track
  })
}

function saveSpotifyMatch(item = match, recordingCode = code, itemId = seedId) {
  return storeSpotifyCodeLookup({
    kind: 'track',
    key: recordingCode,
    itemId,
    jobId,
    match: item,
  })
}

async function billedArtists(trackId: string) {
  return (
    await fixture
      .select({ id: schema.mediaCredit.artistId })
      .from(schema.mediaCredit)
      .where(eq(schema.mediaCredit.mediaItemId, trackId))
      .orderBy(asc(schema.mediaCredit.billingOrder))
  ).map(({ id }) => id)
}

const tidalBilling = tidalCredits.map(({ id }) => artistId('tidal', id))
const pairedBilling = spotifyCredits
  .map(({ id }) => artistId('spotify', id))
  .reverse()

it('reconciles a native Spotify lookup in TIDAL billing order and respects undo', async () => {
  const track = await saveTidalPage()
  const spotifyTrack = await fixture.transaction((tx) =>
    observeCatalogMedia(
      tx,
      {
        kind: 'track',
        title,
        provider: 'spotify',
        referenceType: 'track',
        externalId: spotifyId,
        credits: spotifyCredits.map(({ id, name }) => ({
          externalId: id,
          name,
        })),
      },
      {
        provider: 'spotify',
        operation: 'spotify-code-search',
        occurrenceKey: code,
      },
    ),
  )
  expect(await billedArtists(track)).toEqual(tidalBilling)
  await saveSpotifyMatch()
  expect(await billedArtists(track)).toEqual(pairedBilling)
  expect(await billedArtists(spotifyTrack)).toEqual(
    [...pairedBilling].reverse(),
  )
  const changes = await fixture
    .select()
    .from(schema.libraryChange)
    .where(eq(schema.libraryChange.actor, 'automatic'))
  const change = changes.find((row) => row.sources[0]?.id === tidalBilling[1])
  if (!change) throw new Error('Expected an automatic artist merge')
  await undoLibraryChange(change.id)
  expect(await billedArtists(track)).toEqual([
    pairedBilling[0],
    tidalBilling[1],
  ])
  const afterUndo = await billedArtists(track)
  await saveSpotifyMatch()
  expect(await repairStoredSimilarArtists(true, fixture)).toBe(0)
  expect(await billedArtists(track)).toEqual(afterUndo)

  const oldTarget = pairedBilling[1]
  if (!oldTarget) throw new Error('Expected the second Spotify credit')
  const newTarget = 'fixture-kept-indigo'
  await fixture.insert(schema.artist).values({
    id: newTarget,
    name: 'Fixture Indigo',
  })
  await mergeArtists({
    artistIds: [oldTarget, newTarget],
    targetId: newTarget,
    reviewed: true,
    follow: false,
  })
  await saveSpotifyMatch()
  expect(await repairStoredSimilarArtists(true, fixture)).toBe(0)
  expect(await billedArtists(track)).toEqual(afterUndo)
})

it('reconciles when the first-party lookup precedes the TIDAL observation', async () => {
  await saveSpotifyMatch()
  const track = await saveTidalPage()
  expect(await billedArtists(track)).toEqual(tidalBilling)
  await backfillTidalSimilarDiscoveries({ apply: true, limit: 1 })
  expect(await billedArtists(track)).toEqual(pairedBilling)
})

it('replays retained collaboration evidence and reports a preview without writing', async () => {
  await saveSpotifyMatch(match, code, 'absent-seed')
  const track = await saveTidalPage()
  expect(await repairStoredSimilarArtists(false, fixture)).toBe(2)
  expect(await billedArtists(track)).toEqual(tidalBilling)
  expect(await repairStoredSimilarArtists(true, fixture)).toBe(2)
  expect(await billedArtists(track)).toEqual(pairedBilling)
  expect(
    await fixture.transaction((tx) =>
      reconcileSimilarArtistCredits(tx, [suggestion]),
    ),
  ).toBe(0)
})

it('recognizes a unique artist credited with different letter case on the same recording', async () => {
  const track = await saveTidalPage()
  const artists = spotifyCredits.map(({ id, name }) => ({
    id,
    name: name.toUpperCase(),
  }))
  await saveSpotifyMatch({
    ...match,
    artists: artists.map((artist) => artist.name),
    artistCredits: artists,
  })
  expect(await billedArtists(track)).toEqual(pairedBilling)
})

it('keeps duplicate names separate while pairing another unique credit', async () => {
  const repeatedName = 'Fixture Indigo'
  const extraTidal = { id: '303', name: repeatedName }
  const extraSpotify = { id: 'R'.repeat(22), name: repeatedName }
  const tidalArtists = [...tidalCredits, extraTidal]
  const spotifyArtists = [extraSpotify, ...spotifyCredits]
  const track = await saveTidalPage({
    ...suggestion,
    artists: tidalArtists.map(({ name }) => name),
    artistCredits: tidalArtists,
  })
  await fixture.insert(schema.artist).values({
    id: artistId('spotify', extraSpotify.id),
    name: repeatedName,
    catalogProvider: 'spotify',
    catalogExternalId: extraSpotify.id,
  })
  await saveSpotifyMatch({
    ...match,
    artists: spotifyArtists.map(({ name }) => name),
    artistCredits: spotifyArtists,
  })
  expect(await billedArtists(track)).toEqual([
    pairedBilling[0],
    tidalBilling[1],
    artistId('tidal', extraTidal.id),
  ])
})

it.each([
  {
    label: 'incomplete native IDs',
    patch: { artistCredits: spotifyCredits.slice(0, 1) },
  },
  { label: 'incomplete names', patch: { artists: match.artists.slice(0, 1) } },
  { label: 'unknown duration', patch: { durationSec: null } },
  { label: 'a different duration', patch: { durationSec: 203 } },
  { label: 'a different version', patch: { title: title + ' (Live)' } },
])('keeps the TIDAL billing for $label', async ({ patch }) => {
  const track = await saveTidalPage()
  await saveSpotifyMatch({ ...match, ...patch })
  expect(await billedArtists(track)).toEqual(tidalBilling)
})

it('keeps a credit separate if another stored recording suggests a different ID', async () => {
  const anotherSeed = 'fixture-second-recommendation-seed'
  const anotherCode = 'USZZZ2600101'
  const anotherTitle = 'Fixture Second Collaboration'
  const anotherSpotify = 'T'.repeat(22)
  const alternative = 'U'.repeat(22)
  await fixture.insert(schema.mediaItem).values({
    id: anotherSeed,
    slug: anotherSeed,
    title: 'Fixture Second Seed',
    mediaType: 'track',
  })
  await saveTidalPage(
    {
      ...suggestion,
      code: anotherCode,
      title: anotherTitle,
      tidalId: '987655',
      url: 'https://tidal.com/track/987655',
    },
    anotherSeed,
  )
  await saveSpotifyMatch(
    {
      ...match,
      title: anotherTitle,
      spotifyId: anotherSpotify,
      url: 'https://open.spotify.com/track/' + anotherSpotify,
      artistCredits: spotifyCredits.map((credit) =>
        credit.name === 'Fixture Cobalt'
          ? { ...credit, id: alternative }
          : credit,
      ),
    },
    anotherCode,
    'absent-seed',
  )
  const track = await saveTidalPage()
  await saveSpotifyMatch()
  expect(await billedArtists(track)).toEqual([
    tidalBilling[0],
    pairedBilling[1],
  ])
  expect(await repairStoredSimilarArtists(true, fixture)).toBe(0)
})

it.each([
  { condition: 'captured', readable: true },
  { condition: 'malformed', readable: false },
])(
  'agrees with replay when a superseded Similar receipt is $condition',
  async ({ readable }) => {
    const olderJobId = 'fixture-superseded-similar'
    const olderCode = 'USZZZ2600102'
    const olderTitle = 'Fixture Earlier Collaboration'
    const olderSpotifyId = 'O'.repeat(22)
    const olderTidalId = '987656'
    await fixture.insert(schema.scrapeJob).values({
      id: olderJobId,
      status: 'succeeded',
      provider: 'tidal',
      scope: {},
      options: { task: 'tidal-similar', itemId: seedId },
    })
    const earlierPage = {
      data: [{ id: olderTidalId, type: 'tracks' }],
      included: [
        {
          type: 'tracks',
          id: olderTidalId,
          attributes: {
            title: olderTitle,
            isrc: olderCode,
            duration: 'PT3M20S',
          },
          relationships: {
            artists: {
              data: tidalCredits.map(({ id }) => ({ id, type: 'artists' })),
            },
          },
        },
        ...tidalCredits.map(({ id, name }) => ({
          id,
          type: 'artists',
          attributes: { name },
        })),
      ],
    }
    const other = JSON.stringify({
      ...earlierPage,
      data: [{ id: '888', type: 'tracks' }],
    })
    await fixture.insert(schema.providerResponse).values(
      [readable ? JSON.stringify(earlierPage) : '[', other].map(
        (text, index) => ({
          id: 'fixture-superseded-similar-receipt-' + index,
          jobId: olderJobId,
          provider: 'tidal',
          attempt: 1,
          ordinal: index + 1,
          phase: 'task',
          method: 'GET',
          status: 200,
          requestUrl:
            'https://openapi.tidal.com/v2/tracks/999/relationships/similarTracks',
          bodyState: 'captured',
          body: { state: 'captured', text },
          retainedBytes: Buffer.byteLength(text),
        }),
      ),
    )
    await saveSpotifyMatch(
      {
        ...match,
        title: olderTitle,
        spotifyId: olderSpotifyId,
        url: 'https://open.spotify.com/track/' + olderSpotifyId,
        artistCredits: spotifyCredits.map((credit) =>
          credit.name === 'Fixture Cobalt'
            ? { ...credit, id: 'Z'.repeat(22) }
            : credit,
        ),
      },
      olderCode,
      'absent-seed',
    )
    await saveSpotifyMatch(match, code, 'absent-seed')
    const track = await saveTidalPage()
    const expected = readable ? 1 : 2
    expect(await repairStoredSimilarArtists(false, fixture)).toBe(expected)
    expect(await billedArtists(track)).toEqual(tidalBilling)
    const parseReceipt = vi.spyOn(storedPages, 'parseStoredTrackSimilarReceipt')
    try {
      expect(
        await fixture.transaction((tx) =>
          reconcileSimilarArtistCredits(tx, [suggestion]),
        ),
      ).toBe(expected)
      expect(parseReceipt).toHaveBeenCalledTimes(readable ? 1 : 0)
    } finally {
      parseReceipt.mockRestore()
    }
    expect(await billedArtists(track)).toEqual(
      readable ? [tidalBilling[0], pairedBilling[1]] : pairedBilling,
    )
  },
)

it('keeps an established TIDAL alias on a Spotify artist separate from a new native ID', async () => {
  await fixture.insert(schema.artist).values({
    id: artistId('tidal', '304'),
    name: 'Fixture Cobalt',
    catalogProvider: 'tidal',
    catalogExternalId: '304',
    mergedIntoId: pairedBilling[0],
  })
  const track = await saveTidalPage()
  await saveSpotifyMatch()
  expect(await billedArtists(track)).toEqual([
    tidalBilling[0],
    pairedBilling[1],
  ])
})

it.each([
  { label: 'both owners agree', wrongOwner: false },
  { label: 'one owner disagrees', wrongOwner: true },
])(
  'uses the first-party ISRC and its separately ordered library credits when $label',
  async ({ wrongOwner }) => {
    const track = await saveTidalPage()
    const alternateOwner = 'fixture-other-cobalt'
    if (wrongOwner)
      await fixture.insert(schema.artist).values({
        id: alternateOwner,
        name: 'Fixture Cobalt',
      })
    await fixture
      .update(schema.mediaItem)
      .set({ title, metadata: { spotifyArtistCredits: spotifyCredits } })
      .where(eq(schema.mediaItem.id, seedId))
    await fixture.insert(schema.libraryTrack).values({
      mediaItemId: seedId,
      spotifyTrackId: spotifyId,
      durationSec: 201,
    })
    await fixture.insert(schema.mediaCredit).values(
      pairedBilling.map((id, billingOrder) => ({
        mediaItemId: seedId,
        artistId: wrongOwner && billingOrder === 0 ? alternateOwner : id,
        billingOrder,
        role: 'artist',
      })),
    )
    await fixture.insert(schema.providerReference).values({
      id: 'fixture-native-isrc',
      mediaItemId: seedId,
      provider: 'spotify',
      referenceType: 'isrc',
      externalId: code,
      metadata: { source: 'spotify-playlist-import' },
    })
    const result = await fixture.transaction((tx) =>
      reconcileSimilarArtistCredits(tx, [suggestion]),
    )
    expect(result).toBe(wrongOwner ? 1 : 2)
    expect(await billedArtists(track)).toEqual(
      wrongOwner ? [tidalBilling[0], pairedBilling[1]] : pairedBilling,
    )
  },
)
