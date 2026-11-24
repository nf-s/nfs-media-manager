import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { env } from '@/env'
import { createStableId } from '@/lib/media-utils'
import * as schema from '@/schemas/db'
import { observeSpotifyPlaylistPage } from '@/services/spotify-playlists'
import { observeSpotifyPlaylistPageBatch } from '@/services/spotify-playlist-observations'

const database = `playlist_evidence_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const logQuery = vi.fn<(query: string, params: unknown[]) => void>()
const db = drizzle(pool, { schema, logger: { logQuery } })
type Page = Parameters<typeof observeSpotifyPlaylistPage>[2]
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
const nativeId = (prefix: string, index: number) =>
  `${prefix}${String(index).padStart(21, '0')}`

let created = false
beforeAll(async () => {
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(db, { migrationsFolder: './drizzle' })
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
})

const page: Page = {
  page: 1,
  total: 50,
  entries: Array.from({ length: 50 }, (_, index) => ({
    position: index + 1,
    track: {
      spotifyTrackId: nativeId('T', index),
      title: `Recording ${index}`,
      artists: [`Performer ${index}`],
      artistCredits: [{ id: nativeId('A', index), name: `Performer ${index}` }],
      albumArtistCredits: [
        { id: nativeId('A', index), name: `Performer ${index}` },
      ],
      durationSec: 180,
      albumName: `Release ${index}`,
      spotifyAlbumId: nativeId('R', index),
      artworkUrl: null,
      releaseDate: null,
      isrc: null,
      addedAt: null,
    },
  })),
}
const evidence = {
  snapshot: 'fixture-version',
  observedAt: new Date('2026-01-15T02:30:00Z'),
  complete: true,
}

async function seedTracks(
  tx: Transaction,
  entries: Page['entries'],
  shadowId?: string,
) {
  const tracks = new Map(
    entries.flatMap(({ track }) =>
      track ? [[track.spotifyTrackId, track]] : [],
    ),
  )
  await tx.insert(schema.mediaItem).values(
    [...tracks.values()].map(({ spotifyTrackId, title, artists }) => ({
      id: spotifyTrackId,
      mediaType: 'track',
      slug: spotifyTrackId,
      title: `Stored ${title}`,
      inLibrary: spotifyTrackId !== shadowId,
      metadata:
        spotifyTrackId === shadowId
          ? {
              spotifyArtistCredits: [
                { id: nativeId('A', 3), name: artists[0] ?? '' },
              ],
            }
          : {},
    })),
  )
  await tx.insert(schema.libraryTrack).values(
    [...tracks.keys()].map((spotifyTrackId) => ({
      mediaItemId: spotifyTrackId,
      spotifyTrackId,
    })),
  )
}

function rowValues<T extends { createdAt: Date; updatedAt: Date }>({
  createdAt,
  updatedAt,
  ...row
}: T) {
  return row
}

async function catalogState(tx: Transaction) {
  return {
    media: (
      await tx.select().from(schema.mediaItem).orderBy(schema.mediaItem.id)
    ).map(rowValues),
    albums: (
      await tx.select().from(schema.album).orderBy(schema.album.mediaItemId)
    ).map(rowValues),
    tracks: (
      await tx
        .select()
        .from(schema.libraryTrack)
        .orderBy(schema.libraryTrack.mediaItemId)
    ).map(rowValues),
    artists: (
      await tx.select().from(schema.artist).orderBy(schema.artist.id)
    ).map(rowValues),
    references: (
      await tx
        .select()
        .from(schema.providerReference)
        .orderBy(schema.providerReference.id)
    ).map(rowValues),
    credits: await tx
      .select()
      .from(schema.mediaCredit)
      .orderBy(
        schema.mediaCredit.mediaItemId,
        schema.mediaCredit.artistId,
        schema.mediaCredit.role,
      ),
    observations: await tx
      .select()
      .from(schema.catalogObservation)
      .orderBy(schema.catalogObservation.id),
  }
}

async function withRollback<T>(run: (tx: Transaction) => Promise<T>) {
  let result: T | undefined
  await expect(
    db.transaction(async (tx) => {
      result = await run(tx)
      tx.rollback()
    }),
  ).rejects.toThrow('Rollback')
  if (!result) throw new Error('Fixture transaction exited early.')
  return result
}

it.each([
  { name: 'new releases', ambiguous: false, budget: 18 },
  { name: 'one ambiguous release', ambiguous: true, budget: 110 },
])(
  'retains a full page with $name within its statement budget',
  async ({ ambiguous, budget }) => {
    const run = (observe: typeof observeSpotifyPlaylistPage) =>
      withRollback(async (tx) => {
        await seedTracks(tx, page.entries)
        if (ambiguous) {
          const matches = ['first-release-match', 'second-release-match']
          await tx.insert(schema.mediaItem).values(
            matches.map((id) => ({
              id,
              mediaType: 'album',
              title: 'Stored album',
              slug: id,
              inLibrary: true,
            })),
          )
          await tx
            .insert(schema.album)
            .values(matches.map((id) => ({ mediaItemId: id })))
          await tx.insert(schema.providerReference).values(
            matches.map((id) => ({
              id: `ref-${id}`,
              mediaItemId: id,
              provider: 'spotify',
              referenceType: 'spotify',
              externalId: nativeId('R', 25),
            })),
          )
        }
        logQuery.mockClear()
        await observe(tx, 'fixture-playlist', page, evidence)
        return {
          statements: logQuery.mock.calls.length,
          state: await catalogState(tx),
        }
      })
    const baseline = await run(observeSpotifyPlaylistPage)
    const batch = await run(observeSpotifyPlaylistPageBatch)
    expect(batch.statements).toBeLessThanOrEqual(budget)
    expect(batch.statements).toBeLessThan(baseline.statements / 5)
    expect(batch.state).toEqual(baseline.state)
  },
)

it('preserves duplicate positions, provisional records, rejected matches and merged identities', async () => {
  const entries = page.entries
    .slice(0, 7)
    .flatMap(({ position, track }): Page['entries'] => {
      if (!track) return []
      if (position === 4) {
        const fallback = {
          ...track,
          artistCredits: [],
          addedAt: '2026-04-03T02:00:00Z',
        }
        return [
          { position, track: fallback },
          {
            position: 9,
            track: {
              ...fallback,
              artworkUrl: 'https://example.test/fixture-cover',
              releaseDate: '2020-10-11',
            },
          },
        ]
      }
      return [
        {
          position,
          track:
            position === 5
              ? {
                  ...track,
                  spotifyAlbumId: null,
                  albumArtistCredits: [{ name: 'Unidentified Album Artist' }],
                }
              : track,
        },
      ]
    })
  entries.push({
    position: 8,
    mention: {
      name: 'Unavailable fixture track',
      artists: [{ name: 'Unidentified Track Artist' }],
    },
  })
  entries.sort((first, second) => first.position - second.position)
  const mixedPage = {
    page: 2,
    total: 59,
    responseId: 'fixture-response',
    entries,
  }
  const blockedId = createStableId(
    'catalog-album',
    JSON.stringify(['spotify', 'spotify', nativeId('R', 0)]),
  )
  const releaseUrl = (index: number) =>
    `https://open.spotify.com/album/${nativeId('R', index)}`
  const albumIds = [
    blockedId,
    'rejected-release',
    'alias-release',
    'current-release',
    'legacy-release',
  ]
  const run = (observe: typeof observeSpotifyPlaylistPage) =>
    withRollback(async (tx) => {
      await seedTracks(tx, entries, nativeId('T', 3))
      await tx.insert(schema.mediaItem).values(
        albumIds.map((id) => ({
          id,
          mediaType: 'album',
          title: 'Reviewed title',
          slug: id,
          inLibrary: true,
        })),
      )
      await tx.insert(schema.album).values(
        albumIds.map((id) => ({
          mediaItemId: id,
          spotifyUrl:
            id === 'rejected-release'
              ? releaseUrl(1)
              : id === 'legacy-release'
                ? releaseUrl(6)
                : null,
        })),
      )
      await tx.insert(schema.providerReference).values([
        {
          id: 'ref-blocked',
          mediaItemId: blockedId,
          provider: 'spotify',
          referenceType: 'spotify_album',
          externalId: nativeId('R', 0),
          metadata: { verified: false },
        },
        {
          id: 'ref-blocked-duplicate',
          mediaItemId: blockedId,
          provider: 'spotify',
          referenceType: 'album',
          externalId: nativeId('R', 0),
        },
        {
          id: 'ref-alias',
          mediaItemId: 'alias-release',
          provider: 'spotify',
          referenceType: 'album',
          externalId: nativeId('R', 2),
        },
      ])
      await tx.insert(schema.mediaOverride).values({
        id: 'fixture-rejection',
        mediaItemId: 'rejected-release',
        field: 'albumMatchRejection',
        value: {
          provider: 'spotify',
          sourceProvider: 'spotify',
          snapshotId: 'fixture-rejected-snapshot',
          referenceType: 'url',
          identifier: releaseUrl(1),
        },
      })
      await tx.insert(schema.catalogMediaAlias).values({
        aliasId: 'alias-release',
        mediaItemId: 'current-release',
      })
      await tx.insert(schema.artist).values([
        { id: 'kept-artist', name: 'Kept artist' },
        {
          id: 'artist-alias',
          name: 'Provider spelling',
          catalogProvider: 'spotify',
          catalogExternalId: nativeId('A', 3),
          mergedIntoId: 'kept-artist',
        },
      ])
      await tx.insert(schema.scrapeJob).values({
        id: 'fixture-job',
        provider: 'spotify',
        scope: {},
        options: {},
      })
      await tx.insert(schema.providerResponse).values({
        id: 'fixture-response',
        jobId: 'fixture-job',
        provider: 'spotify',
        phase: 'task',
        attempt: 1,
        ordinal: 1,
        method: 'GET',
        status: 200,
        bodyState: 'captured',
        retainedBytes: 2,
        body: { state: 'captured', text: '{}' },
      })
      const version = { ...evidence, jobId: 'fixture-job' }
      logQuery.mockClear()
      await observe(tx, 'fixture-playlist', mixedPage, version)
      const statements = logQuery.mock.calls.length
      const state = await catalogState(tx)
      await observe(tx, 'fixture-playlist', mixedPage, version)
      expect(await catalogState(tx)).toEqual(state)
      return { state, statements }
    })
  const baseline = await run(observeSpotifyPlaylistPage)
  const batch = await run(observeSpotifyPlaylistPageBatch)
  expect(batch.statements).toBeLessThanOrEqual(18)
  expect(batch.state).toEqual(baseline.state)
  expect(batch.state.observations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        targetId: 'alias-release',
        mediaItemId: 'current-release',
        jobId: 'fixture-job',
        responseId: 'fixture-response',
        page: 2,
        position: 3,
      }),
      expect.objectContaining({
        targetId: 'artist-alias',
        subjectId: nativeId('T', 3),
        relationshipRole: 'artist',
        position: 1,
      }),
      expect.objectContaining({
        targetId: nativeId('T', 3),
        position: 9,
        details: {
          snapshot: 'fixture-version',
          version: 'fixture-job',
          complete: true,
          total: 59,
          addedAt: '2026-04-03T02:00:00Z',
        },
      }),
    ]),
  )
  expect(batch.state.credits).toContainEqual({
    mediaItemId: nativeId('T', 3),
    artistId: 'kept-artist',
    billingOrder: 0,
    role: 'artist',
    creditedAs: null,
  })
  expect(
    batch.state.observations.some(
      ({ targetId }) =>
        targetId === blockedId || targetId === 'rejected-release',
    ),
  ).toBe(false)
})
