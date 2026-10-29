import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import { NFO_CREATION_SOURCE } from '@/lib/film-added-date'

const database = `media_nfo_test_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [],
}))
let directory = ''
let created = false
beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden in NFO tests')
    }),
  )
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
  directory = await mkdtemp(join(tmpdir(), 'media-nfo-test-'))
  await writeFile(
    join(directory, 'movie.nfo'),
    '<movie><title>Fixture</title><id>tt9999911</id><dateadded>2001-01-01</dateadded></movie>',
  )
})
beforeEach(async () => {
  await databaseClient.delete(schema.providerSnapshot)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.insert(schema.mediaItem).values({
    id: 'fixture',
    mediaType: 'film',
    title: 'Fixture',
    slug: 'fixture',
    metadata: { other: 'preserved' },
  })
  await databaseClient.insert(schema.film).values({
    mediaItemId: 'fixture',
    sourceKind: 'file',
    dateAdded: new Date('2001-01-01'),
    dateAddedSource: 'NFO added date',
  })
  await databaseClient.insert(schema.providerReference).values({
    id: 'reference',
    mediaItemId: 'fixture',
    provider: 'nfo',
    referenceType: 'imdb',
    externalId: 'tt9999911',
  })
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  if (directory) await rm(directory, { recursive: true })
  vi.unstubAllGlobals()
})
describe('NFO filesystem dates', () => {
  it('reads birthtime rather than XML date and stores the absolute path', async () => {
    const { collectFilmRecords } = await import('@/services/file-imports')
    const path = join(directory, 'movie.nfo')
    const { records } = await collectFilmRecords({
      format: 'nfo',
      path: directory,
      limit: 5,
      fullImport: false,
    })
    const createdAt = new Date((await stat(path)).birthtimeMs).toISOString()
    expect(records[0]?.result.normalized.filmPatch?.dateAdded).toBe(createdAt)
    expect(records[0]?.result.normalized.mediaPatch?.metadata?.nfo).toEqual({
      path,
      createdAt,
    })
  })
  it('dry-runs without writes, then records a transactional audit and is idempotent', async () => {
    const { auditNfoDates, applyNfoDateAudit, summarizeNfoAudit } =
      await import('@/services/nfo-date-audit')
    const audit = await auditNfoDates(directory, [])
    expect(summarizeNfoAudit(audit)).toMatchObject({
      filmsAudited: 1,
      matched: 1,
      datesToRepair: 1,
      pathsToRepair: 1,
    })
    expect((await databaseClient.query.film.findFirst())?.dateAddedSource).toBe(
      'NFO added date',
    )
    expect(await applyNfoDateAudit(audit)).toEqual({
      datesRepaired: 1,
      pathsRepaired: 1,
    })
    expect((await databaseClient.query.film.findFirst())?.dateAddedSource).toBe(
      NFO_CREATION_SOURCE,
    )
    expect(
      (await databaseClient.query.mediaItem.findFirst())?.metadata?.other,
    ).toBe('preserved')
    expect(
      await databaseClient.select().from(schema.providerSnapshot),
    ).toHaveLength(1)
    expect(await applyNfoDateAudit(await auditNfoDates(directory, []))).toEqual(
      { datesRepaired: 0, pathsRepaired: 0 },
    )
    expect(
      await databaseClient.select().from(schema.providerSnapshot),
    ).toHaveLength(1)
  })
  it('preserves manual dates but replaces older estimates, retaining their provenance in history', async () => {
    const { auditNfoDates, applyNfoDateAudit } =
      await import('@/services/nfo-date-audit')
    await databaseClient.insert(schema.mediaOverride).values({
      id: 'manual',
      mediaItemId: 'fixture',
      field: 'dateAdded',
      value: '2001-01-01',
    })
    expect(await applyNfoDateAudit(await auditNfoDates(directory, []))).toEqual(
      { datesRepaired: 0, pathsRepaired: 1 },
    )
    await databaseClient.delete(schema.mediaOverride)
    await databaseClient
      .update(schema.film)
      .set({ dateAddedSource: 'IMDb watchlist (estimated)' })
      .where(eq(schema.film.mediaItemId, 'fixture'))
    expect(await applyNfoDateAudit(await auditNfoDates(directory, []))).toEqual(
      { datesRepaired: 1, pathsRepaired: 0 },
    )
    expect((await databaseClient.query.film.findFirst())?.dateAddedSource).toBe(
      NFO_CREATION_SOURCE,
    )
    const snapshots = await databaseClient
      .select()
      .from(schema.providerSnapshot)
    expect(
      snapshots.some((snapshot) =>
        JSON.stringify(snapshot.payload).includes('IMDb watchlist (estimated)'),
      ),
    ).toBe(true)
    const { recordFilmAddedDate } = await import('@/services/film-added-dates')
    expect(
      await recordFilmAddedDate(databaseClient, 'fixture', {
        dateAdded: '1990-01-01T00:00:00.000Z',
        dateAddedSource: 'IMDb watchlist (estimated)',
      }),
    ).toEqual([])
  })
  it('rejects stale repair plans without writes', async () => {
    const { auditNfoDates, applyNfoDateAudit } =
      await import('@/services/nfo-date-audit')
    const audit = await auditNfoDates(directory, [])
    await databaseClient
      .update(schema.film)
      .set({ dateAdded: new Date('2002-01-01') })
      .where(eq(schema.film.mediaItemId, 'fixture'))
    await expect(applyNfoDateAudit(audit)).rejects.toThrow(
      'changed since audit',
    )
    expect(
      (await databaseClient.query.mediaItem.findFirst())?.metadata?.nfo,
    ).toBeUndefined()
    expect(
      await databaseClient.select().from(schema.providerSnapshot),
    ).toHaveLength(0)
  })
  it('rolls back a batch when identifiers change after the dry run', async () => {
    const { auditNfoDates, applyNfoDateAudit } =
      await import('@/services/nfo-date-audit')
    await databaseClient.insert(schema.mediaItem).values({
      id: 'second',
      mediaType: 'film',
      title: 'Second',
      slug: 'second',
    })
    await databaseClient
      .insert(schema.film)
      .values({ mediaItemId: 'second', sourceKind: 'file' })
    await databaseClient.insert(schema.providerReference).values({
      id: 'second-reference',
      mediaItemId: 'second',
      provider: 'nfo',
      referenceType: 'imdb',
      externalId: 'tt9999911',
    })
    const audit = await auditNfoDates(directory, [])
    audit.results.sort((a, b) => a.id.localeCompare(b.id))
    await databaseClient
      .update(schema.providerReference)
      .set({ externalId: 'tt9999999' })
      .where(eq(schema.providerReference.id, 'second-reference'))
    await expect(applyNfoDateAudit(audit)).rejects.toThrow(
      'identifiers changed',
    )
    expect(
      (
        await databaseClient.query.film.findFirst({
          where: eq(schema.film.mediaItemId, 'fixture'),
        })
      )?.dateAddedSource,
    ).toBe('NFO added date')
    expect(
      await databaseClient.select().from(schema.providerSnapshot),
    ).toHaveLength(0)
  })
  it('does not replace a corrected birthtime with a stale XML date on legacy reimport', async () => {
    const { recordFilmAddedDate } = await import('@/services/film-added-dates')
    await recordFilmAddedDate(databaseClient, 'fixture', {
      dateAdded: '2020-01-01T00:00:00.000Z',
      dateAddedSource: NFO_CREATION_SOURCE,
    })
    expect(
      await recordFilmAddedDate(databaseClient, 'fixture', {
        dateAdded: '1990-01-01T00:00:00.000Z',
        dateAddedSource: 'NFO added date',
      }),
    ).toEqual([])
    expect(
      (await databaseClient.query.film.findFirst())?.dateAdded?.toISOString(),
    ).toBe('2020-01-01T00:00:00.000Z')
  })
})
