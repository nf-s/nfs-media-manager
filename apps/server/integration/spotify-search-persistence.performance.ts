import { and, eq, inArray } from 'drizzle-orm'
import { expect, it } from 'vitest'
import * as schema from '@/schemas/db'
import { observeSpotifySearchResults } from '@/services/music-catalog-observations'
import { spotifySearchObservations } from '@/services/provider-search-task-replay'
import { createTrackPerformanceFixture } from './fixtures/track-performance'

const { database, checkBudget } = createTrackPerformanceFixture()
const nativeId = (prefix: string, index: number) =>
  `${prefix}${String(index).padStart(21, '0')}`

it('stores a Spotify search page and its evidence within a fixed statement budget', async () => {
  const responseId = 'fixture-spotify-search-response'
  const jobId = 'fixture-spotify-search-job'
  await database.insert(schema.scrapeJob).values({
    id: jobId,
    provider: 'spotify',
    scope: {},
    options: {},
  })
  await database.insert(schema.providerResponse).values({
    id: responseId,
    jobId,
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
  await database
    .update(schema.libraryTrack)
    .set({ spotifyTrackId: nativeId('T', 0) })
    .where(eq(schema.libraryTrack.mediaItemId, 'track-1'))

  const performers = [{ id: nativeId('A', 0), name: 'Fixture performer' }]
  const items = Array.from({ length: 9 }, (_, index) => ({
    id: nativeId('T', index),
    name: `Search recording ${index}`,
    duration_ms: 180_000,
    artists: performers,
    album: {
      id: nativeId('R', Math.floor(index / 2)),
      name: `Search release ${Math.floor(index / 2)}`,
      artists: performers,
    },
    external_ids: { isrc: `ZZF0126${String(index).padStart(5, '0')}` },
    is_playable: index !== 8,
  }))
  const observations = spotifySearchObservations(
    [...items, { name: 'Unavailable recording', artists: performers }],
    10,
  )
  expect(observations).toHaveLength(10)

  const run = () =>
    database.transaction((tx) =>
      observeSpotifySearchResults(tx, observations, {
        operation: 'catalog-search',
        key: jobId,
        responseId,
        jobId,
        page: 2,
      }),
    )
  const ids = await checkBudget('Spotify search persistence', 2_000, 20, run)
  expect(ids.size).toBe(9)
  expect(ids.get(nativeId('T', 0))).toBe('track-1')
  const unavailable = ids.get(nativeId('T', 8))
  expect(unavailable).toBeDefined()
  const retained = await database
    .select()
    .from(schema.catalogObservation)
    .where(eq(schema.catalogObservation.responseId, responseId))
  const tracks = retained.filter(({ targetKind }) => targetKind === 'track')
  expect(tracks.map(({ position }) => position).sort()).toEqual(
    Array.from({ length: 10 }, (_, index) => index + 11),
  )
  expect(tracks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        targetId: unavailable,
        details: { playable: false },
      }),
      expect.objectContaining({ position: 20, details: { playable: false } }),
    ]),
  )
  const releases = retained.filter(({ targetKind }) => targetKind === 'album')
  expect(releases).toHaveLength(9)
  expect(new Set(releases.map(({ targetId }) => targetId)).size).toBe(5)
  expect(
    retained.filter(({ targetKind }) => targetKind === 'artist'),
  ).toHaveLength(19)
  const recordings = await database
    .select({
      id: schema.libraryTrack.mediaItemId,
      spotifyTrackId: schema.libraryTrack.spotifyTrackId,
      albumMediaItemId: schema.libraryTrack.albumMediaItemId,
      inLibrary: schema.mediaItem.inLibrary,
    })
    .from(schema.libraryTrack)
    .innerJoin(
      schema.mediaItem,
      eq(schema.mediaItem.id, schema.libraryTrack.mediaItemId),
    )
    .where(
      inArray(
        schema.libraryTrack.mediaItemId,
        tracks.map(({ targetId }) => targetId),
      ),
    )
  expect(recordings).toHaveLength(10)
  expect(
    recordings.filter(({ inLibrary }) => inLibrary).map(({ id }) => id),
  ).toEqual(['track-1'])
  expect(recordings.find(({ id }) => id === unavailable)).toMatchObject({
    spotifyTrackId: null,
    albumMediaItemId: releases.find(({ position }) => position === 19)
      ?.targetId,
  })
  const codes = await database
    .select()
    .from(schema.providerReference)
    .where(
      and(
        eq(schema.providerReference.referenceType, 'isrc'),
        inArray(schema.providerReference.mediaItemId, [...ids.values()]),
      ),
    )
  expect(codes).toHaveLength(9)
  for (const code of codes)
    expect(code.metadata).toMatchObject({
      source: 'spotify-search-response',
      responseId,
    })
  expect(
    await checkBudget('Spotify search evidence replay', 2_000, 20, run),
  ).toEqual(ids)
  expect(
    await database.$count(
      schema.catalogObservation,
      eq(schema.catalogObservation.responseId, responseId),
    ),
  ).toBe(retained.length)
})

it('resolves repeated search hits in source order as their native identities become available', async () => {
  const spotifyTrackId = nativeId('D', 1)
  const spotifyAlbumId = nativeId('D', 2)
  const track = {
    id: spotifyTrackId,
    name: 'Repeated recording',
    duration_ms: 180_000,
    artists: [{ name: 'Repeated performer' }],
  }
  const observations = spotifySearchObservations(
    [
      {
        ...track,
        is_playable: false,
        album: { name: 'Repeated release' },
      },
      {
        ...track,
        name: 'Later title',
        is_playable: true,
        album: { id: spotifyAlbumId, name: 'Repeated release' },
      },
    ],
    0,
  )
  const ids = await database.transaction((tx) =>
    observeSpotifySearchResults(tx, observations, {
      operation: 'catalog-search',
      key: 'fixture-repeated-search',
      page: 1,
    }),
  )
  const [recording] = await database
    .select({
      id: schema.mediaItem.id,
      title: schema.mediaItem.title,
      spotifyAlbumId: schema.libraryTrack.spotifyAlbumId,
      albumLinkStrategy: schema.libraryTrack.albumLinkStrategy,
    })
    .from(schema.libraryTrack)
    .innerJoin(
      schema.mediaItem,
      eq(schema.mediaItem.id, schema.libraryTrack.mediaItemId),
    )
    .where(eq(schema.libraryTrack.spotifyTrackId, spotifyTrackId))
  expect(recording).toMatchObject({
    id: ids.get(spotifyTrackId),
    title: 'Repeated recording',
    spotifyAlbumId,
    albumLinkStrategy: 'spotify-album',
  })
  if (!recording) throw new Error('Expected a saved Spotify recording.')
  const evidence = await database
    .select({
      position: schema.catalogObservation.position,
      details: schema.catalogObservation.details,
    })
    .from(schema.catalogObservation)
    .where(eq(schema.catalogObservation.targetId, recording.id))
    .orderBy(schema.catalogObservation.position)
  expect(evidence).toEqual([
    { position: 1, details: { playable: false } },
    { position: 2, details: { playable: true } },
  ])
})
