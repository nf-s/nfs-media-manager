import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  SpotifyTrackAuditPageSchema,
  type SpotifyTrackAuditItem,
} from '@repo/schemas/spotify-track-search'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import { listTracksNeedingSpotifyMatch } from '@/services/track-match-diagnostics'

const database = 'spotify_audit_list_' + randomUUID().replaceAll('-', '')
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const fixture = drizzle(pool, { schema })
const request = vi.fn(() => {
  throw new Error('Network forbidden')
})
const owner = 'fixture-owner'
const other = 'fixture-other'
const artist = 'Fixture Artist'
const artistId = 'fixture-artist'
const sourceDate = new Date('2026-01-01T00:00:00.000Z')
const otherDate = new Date('2026-01-02T00:00:00.000Z')
const auditPath = '/api/v1/spotify/tracks/match-audit'

vi.mock('@/lib/load-workspace-env', () => ({
  findWorkspaceRootPath: () => null,
  loadWorkspaceEnv: () => {},
}))
vi.mock('@/plugins/registry', () => ({
  getScrapePlugin: async () => null,
  listLoadedScrapePlugins: async () => [],
}))
vi.mock('@/lib/db', () => ({
  get db() {
    return fixture
  },
}))
vi.mock('@/lib/auth', () => ({
  auth: {
    api: {
      async getSession({ headers }: { headers: Headers }) {
        const cookie = headers.get('cookie')
        if (cookie !== 'session=fixture' && cookie !== 'session=other')
          return null
        const userId = cookie === 'session=fixture' ? owner : other
        return {
          user: { id: userId, email: userId + '@example.test' },
          session: { userId },
        }
      },
    },
  },
}))

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', request)
  await admin.connect()
  await admin.query('create database ' + database)
  created = true
  await migrate(fixture, { migrationsFolder: './drizzle' })
  await fixture.insert(schema.user).values([
    { id: owner, name: 'Fixture Owner', email: owner + '@example.test' },
    { id: other, name: 'Fixture Other', email: other + '@example.test' },
  ])
  await fixture.insert(schema.artist).values({ id: artistId, name: artist })

  await track('signal-a', 'Signal Arc')
  await track('signal-b', 'signal arc')
  await track('pilot', 'Alpine Pilot')
  await track('clock', 'Pilot Clock')
  await track('alternate', 'Alternate Wake', { isrc: 'AAFIX2600001' })
  await track('playable-sibling', 'Alternate Wake', {
    isrc: 'AAFIX2600001',
    spotifyTrackId: '2'.repeat(22),
  })
  await track('direct', 'Direct Match', { spotifyTrackId: '3'.repeat(22) })
  await track('hidden', 'Hidden Track', { hidden: true })
  await track('other', 'Foreign Report Track')
  await audit('signal-a', 'Signal Arc', 'likely', 2, 'Album 100%_Pulse')
  await audit('signal-b', 'signal arc', 'likely', 4, 'Album 100AXPulse')
  await audit('pilot', 'Alpine Pilot', 'review', 1)
  await audit('alternate', 'Alternate Wake', 'review', 2)
  await audit('clock', 'Pilot Clock', 'unlikely', 3)
  await audit('direct', 'Direct Match', 'likely', 1)
  await audit('hidden', 'Hidden Track', 'likely', 1)
  await audit('other', 'Foreign Report Track', 'likely', 1, undefined, other)
  await audit('signal-a', 'Signal Arc', 'unlikely', 1, undefined, other)
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query('drop database ' + database)
  await admin.end()
  vi.unstubAllGlobals()
})

async function track(
  id: string,
  title: string,
  options: { hidden?: boolean; isrc?: string; spotifyTrackId?: string } = {},
) {
  await fixture.insert(schema.mediaItem).values({
    id,
    title,
    slug: id,
    mediaType: 'track',
    sourceLabel: 'album',
    metadata: options.hidden ? { legacyHidden: true } : {},
  })
  await fixture.insert(schema.libraryTrack).values({
    mediaItemId: id,
    durationSec: 174,
    spotifyTrackId: options.spotifyTrackId,
    isrc: options.isrc,
  })
  await fixture.insert(schema.mediaCredit).values({
    mediaItemId: id,
    artistId,
    role: 'artist',
  })
}

async function audit(
  trackId: string,
  title: string,
  assessment: SpotifyTrackAuditItem['assessment'],
  candidateCount: number,
  albumName = 'Fixture Album',
  ownerId = owner,
) {
  const assessedAt = ownerId === owner ? sourceDate : otherDate
  const report: SpotifyTrackAuditItem = {
    trackId,
    title,
    artists: [artist],
    albums: [],
    durations: [174],
    assessment,
    summary: 'Fixture audit',
    candidates: Array.from({ length: candidateCount }, (_, index) => {
      const spotifyTrackId = String(index + 1).padStart(22, '0')
      return {
        spotifyTrackId,
        title,
        artists: [artist],
        albumName,
        durationSec: 174,
        spotifyUrl: 'https://open.spotify.com/track/' + spotifyTrackId,
        assessment,
        summary: 'Fixture candidate',
        reasons: [],
        searchedAt: sourceDate.toISOString(),
        historical: false,
      }
    }),
  }
  await fixture.insert(schema.spotifyTrackMatchAudit).values({
    ownerId,
    trackId,
    assessedAt,
    assessment,
    candidateCount,
    searchText: [title, artist, albumName].join(' ').toLowerCase(),
    report,
  })
}

async function readAudit(query = '', session = 'fixture') {
  const { default: app } = await import('@/app')
  const response = await app.request(auditPath + query, {
    headers: { cookie: 'session=' + session },
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  return z
    .object({ data: SpotifyTrackAuditPageSchema })
    .parse(await response.json()).data
}

it('authenticates the audit route and validates query parameters', async () => {
  const { default: app } = await import('@/app')
  expect((await app.request(auditPath)).status).toBe(401)
  for (const query of ['?sort=unknown', '?size=101', '?q=%00']) {
    const response = await app.request(auditPath + query, {
      headers: { cookie: 'session=fixture' },
    })
    expect(response.status).toBe(422)
  }
})

it('keeps the exact owner scope and shows only visible tracks without a direct ID', async () => {
  // This track has a playable sibling but remains eligible for the audit.
  expect(await listTracksNeedingSpotifyMatch(fixture, ['alternate'])).toEqual(
    [],
  )
  const page = await readAudit('?ownerId=' + other)
  expect(page).toMatchObject({
    generatedAt: sourceDate.toISOString(),
    totalTracks: 5,
    totalCandidates: 12,
    counts: { likely: 2, review: 2, unlikely: 1 },
    totalCount: 5,
    pageCount: 1,
  })
  expect(page.items.map(({ trackId }) => trackId)).toEqual([
    'signal-a',
    'signal-b',
    'pilot',
    'alternate',
    'clock',
  ])
  const otherPage = await readAudit('', 'other')
  expect(otherPage).toMatchObject({
    generatedAt: otherDate.toISOString(),
    totalTracks: 2,
    totalCandidates: 2,
    items: [
      { trackId: 'other', assessment: 'likely' },
      { trackId: 'signal-a', assessment: 'unlikely' },
    ],
  })
  expect(request).not.toHaveBeenCalled()
})

it('combines literal case-insensitive search and assessment while retaining overall totals', async () => {
  const hit = await readAudit('?q=100%25_PULSE&assessment=likely')
  expect(hit).toMatchObject({
    totalTracks: 5,
    totalCandidates: 12,
    counts: { likely: 2, review: 2, unlikely: 1 },
    totalCount: 1,
    pageCount: 1,
    items: [{ trackId: 'signal-a' }],
  })
  expect(await readAudit('?q=100%25_PULSE&assessment=review')).toMatchObject({
    totalCount: 0,
    pageCount: 0,
    items: [],
  })
})

it('sorts and paginates with stable ties and counts beyond the last page', async () => {
  const byTitle = await readAudit('?sort=title&direction=desc&size=2')
  expect(byTitle.items.map(({ trackId }) => trackId)).toEqual([
    'signal-a',
    'signal-b',
  ])
  expect(byTitle.pageCount).toBe(3)
  const byCandidates = await readAudit(
    '?sort=candidates&direction=desc&page=2&size=2',
  )
  expect(byCandidates.items.map(({ trackId }) => trackId)).toEqual([
    'alternate',
    'signal-a',
  ])
  expect(await readAudit('?page=4&size=2')).toMatchObject({
    totalCount: 5,
    pageCount: 3,
    items: [],
  })
})
