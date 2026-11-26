import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { asc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from 'vitest'
import { z } from 'zod'
import {
  LibraryChangePageSchema,
  LibraryChangeSchema,
} from '@repo/schemas/library-changes'
import { AlbumDetailSchema } from '@repo/schemas/media'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import { removeOrphanTracks } from '@/services/album-library-tracks'
import {
  applyAlbumTracklistCorrection,
  type AlbumTracklistPatch,
  type AlbumTracklistPosition,
} from '@/services/album-tracklist-effect'
import { promoteCatalogMedia } from '@/services/catalog-discoveries'
import { recordChange } from '@/services/library-changes'
import { refreshTrackDuplicates } from '@/services/track-duplicate-refresh'
import { removeImportedPlaylist } from '@/services/tracks'

const owner = vi.hoisted(() => ({
  id: 'fixture-album-owner',
  email: 'owner@example.test',
  origin: 'https://albums.example.test',
}))
vi.mock('@/env', async (importOriginal) => {
  const { env } = await importOriginal<typeof import('@/env')>()
  return {
    env: {
      ...env,
      RUNTIME_KIND: 'node',
      APP_URL: owner.origin,
      AUTH_BASE_URL: owner.origin,
      TRUSTED_ORIGINS: [owner.origin],
      OWNER_USER_ID: owner.id,
      OWNER_EMAIL: owner.email,
    },
  }
})
vi.mock('@/lib/db', () => ({
  get db() {
    return fixture
  },
}))

const database = 'album_tracklist_' + randomUUID().replaceAll('-', '')
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: 'postgres' })
const pool = new pg.Pool({ ...connection, database })
const fixture = drizzle(pool, { schema })
const network = vi.fn(() => {
  throw new Error('Unexpected provider request')
})
let created = false
let cookie = ''

const albumId = 'fixture-album'
const oldTrack = 'fixture-old-recording'
const correctedTrack = 'fixture-correct-recording'
const missingTrack = 'fixture-missing-recording'
const unchangedTrack = 'fixture-unchanged-recording'
const dateAdded = new Date('2024-02-01T00:00:00Z')
const earlier = new Date('2023-02-01T00:00:00Z')
const albumPath = `/api/v1/albums/${albumId}`
const historyPath = '/api/v1/library-changes'

function position(
  position: number,
  trackMediaItemId: string,
  fields: Partial<AlbumTracklistPosition> = {},
): AlbumTracklistPosition {
  return {
    id: `fixture-position-${position}`,
    albumMediaItemId: albumId,
    trackMediaItemId,
    position,
    title: `Title from the provider for position ${position}`,
    durationSec: 120 + position,
    externalId: `fixture-provider-track-${position}`,
    metadata: { vendor: { flags: [true, null], sort: 1 }, disc: 1 },
    ...fields,
  }
}

const oldPosition = position(1, oldTrack)
const correctedPosition = { ...oldPosition, trackMediaItemId: correctedTrack }
const missingPosition = position(2, missingTrack, { metadata: null })
const unchangedPosition = position(3, unchangedTrack)
const baseline = [oldPosition, unchangedPosition]
const corrected = [correctedPosition, missingPosition, unchangedPosition]
const patches: AlbumTracklistPatch[] = [
  { before: oldPosition, after: correctedPosition },
  { before: null, after: missingPosition },
  { before: unchangedPosition, after: unchangedPosition },
]

async function request(path: string, init?: RequestInit) {
  const { default: app } = await import('@/app')
  return app.request(new URL(path, owner.origin), {
    ...init,
    headers: { cookie, origin: owner.origin, ...init?.headers },
  })
}

async function correct() {
  return fixture.transaction(async (tx) => {
    const effect = await applyAlbumTracklistCorrection(
      tx,
      albumId,
      patches,
      5,
      3,
    )
    const id = await recordChange(
      tx,
      {
        kind: 'album',
        action: 'move',
        target: { id: albumId, title: 'Fixture Album', by: '' },
        details: { counts: { position: 2 } },
      },
      { effects: [effect] },
    )
    if (!id) throw new Error('The correction was not recorded')
    return id
  })
}

async function history() {
  const response = await request(
    `${historyPath}?kind=album&recordId=${albumId}`,
  )
  expect(response.status).toBe(200)
  return z
    .object({ data: LibraryChangePageSchema })
    .parse(await response.json()).data
}

async function toggle(id: string, action: 'undo' | 'redo') {
  const response = await request(`${historyPath}/${id}/${action}`, {
    method: 'POST',
  })
  expect(response.status).toBe(200)
  return z.object({ data: LibraryChangeSchema }).parse(await response.json())
    .data
}

async function expectAlbum(
  trackCount: number,
  positions: AlbumTracklistPosition[],
) {
  const response = await request(albumPath)
  expect(response.status).toBe(200)
  const { data } = z
    .object({ data: AlbumDetailSchema })
    .parse(await response.json())
  expect(data.trackCount).toBe(trackCount)
  expect(
    data.tracks.map(({ position, track }) => ({ position, id: track.id })),
  ).toEqual(
    positions.map(({ position, trackMediaItemId: id }) => ({ position, id })),
  )
  const rows = await fixture
    .select()
    .from(schema.track)
    .where(eq(schema.track.albumMediaItemId, albumId))
    .orderBy(asc(schema.track.position))
  expect(rows.map(({ createdAt, updatedAt, ...row }) => row)).toEqual(positions)
}

async function membership(id: string) {
  const [row] = await fixture
    .select({
      saved: schema.mediaItem.inLibrary,
      date: schema.libraryTrack.dateAdded,
    })
    .from(schema.mediaItem)
    .innerJoin(
      schema.libraryTrack,
      eq(schema.libraryTrack.mediaItemId, schema.mediaItem.id),
    )
    .where(eq(schema.mediaItem.id, id))
  return row
}

async function duplicateIds() {
  const rows = await fixture
    .select({ id: schema.trackDuplicateMember.trackId })
    .from(schema.trackDuplicateMember)
    .orderBy(asc(schema.trackDuplicateMember.trackId))
  return rows.map(({ id }) => id)
}

beforeAll(async () => {
  vi.stubGlobal('fetch', network)
  await admin.connect()
  await admin.query('create database ' + database)
  created = true
  await migrate(fixture, { migrationsFolder: './drizzle' })
  const password = randomUUID()
  await fixture.insert(schema.user).values({
    id: owner.id,
    name: 'Fixture Owner',
    email: owner.email,
    role: 'admin',
  })
  await fixture.insert(schema.account).values({
    id: 'fixture-owner-account',
    userId: owner.id,
    providerId: 'credential',
    accountId: owner.id,
    password: await hashPassword(password),
    updatedAt: new Date(),
  })
  const login = await request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: owner.email, password }),
  })
  expect(login.status).toBe(200)
  cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
})

beforeEach(async () => {
  await fixture.delete(schema.libraryChange)
  await fixture.delete(schema.track)
  await fixture.delete(schema.mediaItem)
  await fixture.delete(schema.artist)
  await fixture.insert(schema.mediaItem).values({
    id: albumId,
    slug: albumId,
    mediaType: 'album',
    title: 'Fixture Album',
  })
  await fixture
    .insert(schema.album)
    .values({ mediaItemId: albumId, dateAdded, trackCount: 5 })
  const ids = [oldTrack, correctedTrack, missingTrack, unchangedTrack]
  await fixture.insert(schema.mediaItem).values(
    ids.map((id) => ({
      id,
      slug: id,
      mediaType: 'track',
      title: id === missingTrack ? 'Missing Recording' : 'Fixture Recording',
      inLibrary: id === oldTrack || id === unchangedTrack,
    })),
  )
  await fixture.insert(schema.libraryTrack).values(
    ids.map((id) => ({
      mediaItemId: id,
      dateAdded: id === oldTrack || id === unchangedTrack ? dateAdded : null,
    })),
  )
  await fixture.insert(schema.track).values(baseline)
  const artistId = 'fixture-artist'
  await fixture
    .insert(schema.artist)
    .values({ id: artistId, name: 'Fixture Artist' })
  await fixture.insert(schema.mediaCredit).values(
    ids.map((id) => ({
      mediaItemId: id,
      artistId,
      role: 'artist',
    })),
  )
})

afterEach(() => expect(network).not.toHaveBeenCalled())
afterAll(async () => {
  await pool.end()
  if (created) await admin.query('drop database ' + database)
  await admin.end()
  vi.unstubAllGlobals()
})

it('corrects a saved album and restores its exact positions and previous count from History', async () => {
  await expectAlbum(5, baseline)
  await fixture.transaction((tx) => refreshTrackDuplicates(tx))
  expect(await duplicateIds()).toEqual([oldTrack, unchangedTrack])
  const id = await correct()
  await expectAlbum(3, corrected)
  expect(await duplicateIds()).toEqual([correctedTrack, unchangedTrack])
  expect(await membership(oldTrack)).toEqual({ saved: false, date: null })
  expect(await membership(correctedTrack)).toEqual({
    saved: true,
    date: dateAdded,
  })
  expect(await membership(missingTrack)).toEqual({
    saved: true,
    date: dateAdded,
  })
  expect((await history()).items).toMatchObject([
    { id, canUndo: true, canRedo: false },
  ])

  await fixture.transaction((tx) => removeOrphanTracks(tx, [oldTrack]))
  expect(await membership(oldTrack)).toEqual({ saved: false, date: null })
  expect(await toggle(id, 'undo')).toMatchObject({
    id,
    canUndo: false,
    canRedo: true,
  })
  await expectAlbum(5, baseline)
  expect(await duplicateIds()).toEqual([oldTrack, unchangedTrack])
  expect(await membership(oldTrack)).toEqual({ saved: true, date: dateAdded })
  expect(await membership(correctedTrack)).toEqual({ saved: false, date: null })
  expect(await membership(missingTrack)).toEqual({ saved: false, date: null })

  await fixture.transaction((tx) =>
    removeOrphanTracks(tx, [correctedTrack, missingTrack]),
  )
  expect(await toggle(id, 'redo')).toMatchObject({
    id,
    canUndo: true,
    canRedo: false,
  })
  await expectAlbum(3, corrected)
  expect(await duplicateIds()).toEqual([correctedTrack, unchangedTrack])
  expect(await membership(oldTrack)).toEqual({ saved: false, date: null })
  expect(await membership(missingTrack)).toEqual({
    saved: true,
    date: dateAdded,
  })
})

it('keeps a recording independently saved after the correction when Undo removes the position', async () => {
  const id = await correct()
  await fixture.insert(schema.catalogAddition).values({
    mediaItemId: missingTrack,
    ownerId: owner.id,
    addedAt: earlier,
  })
  await toggle(id, 'undo')
  await expectAlbum(5, baseline)
  expect(await membership(missingTrack)).toEqual({ saved: true, date: earlier })
  expect(await membership(correctedTrack)).toEqual({ saved: false, date: null })
})

it('keeps displaced recordings with an independent source from before or after the correction', async () => {
  await fixture.insert(schema.catalogAddition).values({
    mediaItemId: oldTrack,
    ownerId: owner.id,
    addedAt: earlier,
  })
  const first = await correct()
  expect(await membership(oldTrack)).toEqual({ saved: true, date: earlier })
  await toggle(first, 'undo')

  await fixture
    .delete(schema.catalogAddition)
    .where(eq(schema.catalogAddition.mediaItemId, oldTrack))
  const second = await correct()
  expect(await membership(oldTrack)).toEqual({ saved: false, date: null })
  await expect(promoteCatalogMedia(oldTrack, owner.id)).resolves.toMatchObject({
    created: true,
  })
  await toggle(second, 'undo')
  await toggle(second, 'redo')
  expect(await membership(oldTrack)).toEqual({
    saved: true,
    date: expect.any(Date),
  })
})

it('retains orphaned recordings for History after a playlist stops granting membership', async () => {
  const playlistId = 'fixture-temporary-playlist'
  await fixture.insert(schema.playlist).values({
    id: playlistId,
    name: 'Fixture Playlist',
    kind: 'playlist',
    source: 'spotify',
  })
  await fixture.insert(schema.playlistItem).values(
    [oldTrack, correctedTrack].map((mediaItemId, position) => ({
      playlistId,
      mediaItemId,
      position,
      addedAt: earlier,
      admitsToLibrary: true,
    })),
  )
  await fixture
    .update(schema.mediaItem)
    .set({ inLibrary: true })
    .where(eq(schema.mediaItem.id, correctedTrack))
  const id = await correct()
  expect(await membership(oldTrack)).toEqual({ saved: true, date: earlier })
  expect(await membership(correctedTrack)).toEqual({
    saved: true,
    date: earlier,
  })

  await expect(removeImportedPlaylist(playlistId)).resolves.toEqual({
    removedTracks: 1,
  })
  expect(await membership(oldTrack)).toEqual({ saved: false, date: null })
  expect(await membership(correctedTrack)).toEqual({
    saved: true,
    date: dateAdded,
  })
  await toggle(id, 'undo')
  expect(await membership(oldTrack)).toEqual({ saved: true, date: dateAdded })
  expect(await membership(correctedTrack)).toEqual({ saved: false, date: null })
  await toggle(id, 'redo')
  expect(await membership(oldTrack)).toEqual({ saved: false, date: null })
  expect(await membership(correctedTrack)).toEqual({
    saved: true,
    date: dateAdded,
  })
})

it('refuses to apply against an occupied slot and refuses Undo after another position is edited', async () => {
  await fixture.insert(schema.track).values(position(4, unchangedTrack))
  await expect(correct()).rejects.toMatchObject({
    response: { statusCode: 409 },
  })
  expect((await history()).items).toEqual([])
  await expectAlbum(5, [...baseline, position(4, unchangedTrack)])

  await fixture.delete(schema.track).where(eq(schema.track.position, 4))
  const id = await correct()
  await fixture
    .update(schema.track)
    .set({ title: 'Later correction' })
    .where(eq(schema.track.id, unchangedPosition.id))
  expect((await history()).items).toMatchObject([
    { id, canUndo: false, blocked: expect.any(String) },
  ])
  const response = await request(`${historyPath}/${id}/undo`, {
    method: 'POST',
  })
  expect(response.status).toBe(409)
  await expectAlbum(3, [
    correctedPosition,
    missingPosition,
    { ...unchangedPosition, title: 'Later correction' },
  ])
})

it('refuses Redo after a destination recording is deleted', async () => {
  const id = await correct()
  await toggle(id, 'undo')
  await fixture
    .delete(schema.mediaItem)
    .where(eq(schema.mediaItem.id, missingTrack))
  expect((await history()).items).toMatchObject([
    { id, canRedo: false, blocked: expect.any(String) },
  ])
  const response = await request(`${historyPath}/${id}/redo`, {
    method: 'POST',
  })
  expect(response.status).toBe(409)
  await expectAlbum(5, baseline)
})
