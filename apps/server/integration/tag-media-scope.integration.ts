import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { TagListQuerySchema } from '@repo/schemas/tags'
import { AlbumQuerySchema, FilmQuerySchema } from '@repo/schemas/media'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const name = `tag_scope_service_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database: name })
const database = drizzle(pool, { schema })
vi.mock('@/lib/db', () => ({
  get db() {
    return database
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [],
}))
let created = false

beforeAll(async () => {
  vi.stubGlobal('fetch', () => {
    throw new Error('Network forbidden')
  })
  await admin.connect()
  await admin.query(`create database ${name}`)
  created = true
  await database.transaction(async (tx) => {
    for (const migration of readMigrationFiles({
      migrationsFolder: './drizzle',
    }))
      for (const statement of migration.sql)
        await tx.execute(sql.raw(statement))
  })
  await database.insert(schema.mediaItem).values([
    { id: 'film', slug: 'film', title: 'Film', mediaType: 'film' },
    { id: 'album', slug: 'album', title: 'Album', mediaType: 'album' },
  ])
  await database.insert(schema.film).values({ mediaItemId: 'film' })
  await database.insert(schema.album).values({ mediaItemId: 'album' })
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${name}`)
  await admin.end()
  vi.unstubAllGlobals()
})

async function writeTags(mediaType: 'album' | 'film', names: string[]) {
  const { upsertProviderTags, lockTagWrites } =
    await import('@/services/tag-state')
  await database.transaction(async (tx) => {
    await lockTagWrites(tx)
    await upsertProviderTags(
      tx,
      mediaType,
      `fixture-${mediaType}`,
      mediaType,
      names.map((name) => ({
        name,
        kind: 'genre',
        rawName: name,
        source: `fixture-${mediaType}`,
      })),
    )
  })
}

async function findTag(mediaType: 'album' | 'film', name: string) {
  const [tag] = await database
    .select()
    .from(schema.tag)
    .where(and(eq(schema.tag.mediaType, mediaType), eq(schema.tag.name, name)))
  if (!tag) throw new Error('Missing fixture tag')
  return tag
}

describe('media-scoped tag services', () => {
  it('rolls back an incoming update that claims the wrong medium', async () => {
    const { lockTagWrites, upsertProviderTags } =
      await import('@/services/tag-state')
    await expect(
      database.transaction(async (tx) => {
        await lockTagWrites(tx)
        await upsertProviderTags(tx, 'album', 'fixture', 'film', [
          { name: 'Wrong scope', kind: 'genre' },
        ])
      }),
    ).rejects.toMatchObject({ cause: { code: '23514' } })
    expect(
      await database
        .select()
        .from(schema.tag)
        .where(eq(schema.tag.name, 'Wrong scope')),
    ).toEqual([])
  })

  it('never shares identities, provenance or hidden state for matching names', async () => {
    const { listTags, getTagProvenance, setTagVisibility, getTagDetail } =
      await import('@/services/tags')
    await writeTags('film', ['Shared', 'Film target'])
    await writeTags('album', ['Shared', 'Album target'])
    const film = await findTag('film', 'Shared')
    const album = await findTag('album', 'Shared')
    expect(film.id).not.toBe(album.id)
    for (const mediaType of ['album', 'film']) {
      const page = await listTags(
        TagListQuerySchema.parse({ mediaType, q: 'Shared' }),
      )
      expect(page.items).toHaveLength(1)
      expect(page.items[0]).toMatchObject({
        mediaType,
        mediaCount: 1,
        sourceCount: 1,
      })
    }
    await setTagVisibility({
      mediaType: 'film',
      tagIds: [film.id],
      hidden: true,
    })
    expect(
      (await getTagDetail(album.id, { mediaType: 'album', page: 1, size: 25 }))
        .tag.hidden,
    ).toBe(false)
    await expect(
      getTagDetail(album.id, { mediaType: 'film', page: 1, size: 25 }),
    ).rejects.toMatchObject({ statusCode: 404 })
    const origins = await getTagProvenance({
      mediaId: 'album',
      name: 'Shared',
      page: 1,
      size: 25,
    })
    expect(origins.mediaType).toBe('album')
    expect(origins.items.map((row) => row.provider)).toEqual(['fixture-album'])
    await expect(
      getTagProvenance({
        mediaId: 'album',
        mediaType: 'film',
        name: 'Shared',
        page: 1,
        size: 25,
      }),
    ).rejects.toMatchObject({ statusCode: 404 })
    await expect(
      setTagVisibility({
        mediaType: 'film',
        tagIds: [film.id, album.id],
        hidden: true,
      }),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('confines future updates, merged aliases and browse filters to one library', async () => {
    const { mergeTags, getTagDetail } = await import('@/services/tags')
    const { queryBrowseIds } = await import('@/services/browse')
    const film = await findTag('film', 'Shared')
    const album = await findTag('album', 'Shared')
    const target = await findTag('film', 'Film target')
    await expect(
      mergeTags(
        { mediaType: 'film', sourceIds: [album.id], targetId: target.id },
        null,
      ),
    ).rejects.toMatchObject({ statusCode: 404 })
    await mergeTags(
      { mediaType: 'film', sourceIds: [film.id], targetId: target.id },
      null,
    )
    await writeTags('film', ['Shared'])
    await writeTags('album', ['Shared'])
    expect(
      (await getTagDetail(film.id, { mediaType: 'film', page: 1, size: 25 }))
        .tag.id,
    ).toBe(target.id)
    expect(
      (await getTagDetail(album.id, { mediaType: 'album', page: 1, size: 25 }))
        .tag,
    ).toMatchObject({ id: album.id, name: 'Shared', hidden: false })
    expect(
      (await queryBrowseIds('film', FilmQuerySchema.parse({ tag: 'Shared' })))
        .ids,
    ).toEqual(['film'])
    expect(
      (
        await queryBrowseIds(
          'album',
          AlbumQuerySchema.parse({ tag: 'Film target' }),
        )
      ).ids,
    ).toEqual([])
    // Matching the album's target name must not expand through a film-only alias.
    await writeTags('album', ['Film target'])
    await database
      .delete(schema.mediaItemTag)
      .where(
        and(
          eq(schema.mediaItemTag.mediaItemId, 'album'),
          eq(schema.mediaItemTag.tagId, album.id),
        ),
      )
    expect(
      (await queryBrowseIds('album', AlbumQuerySchema.parse({ tag: 'Shared' })))
        .ids,
    ).toEqual([])
  })
})
