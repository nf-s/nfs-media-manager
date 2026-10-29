import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PluginResultSchema, type PluginTag } from '@repo/media-plugin-sdk'
import { TagListQuerySchema } from '@repo/schemas/tags'
import { AlbumQuerySchema, FilmQuerySchema } from '@repo/schemas/media'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const database = `media_tags_test_${randomUUID().replaceAll('-', '')}`
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
let created = false

async function addMedia(id: string, mediaType: 'film' | 'album' = 'film') {
  await databaseClient
    .insert(schema.mediaItem)
    .values({ id, title: id, slug: id, mediaType })
  if (mediaType === 'film')
    await databaseClient.insert(schema.film).values({ mediaItemId: id })
  else await databaseClient.insert(schema.album).values({ mediaItemId: id })
}

async function applyTags(
  mediaItemId: string,
  tags: PluginTag[],
  provider = 'tmdb',
  mediaType: 'film' | 'album' = 'film',
) {
  const { applyProviderResult } = await import('@/services/provider-state')
  await applyProviderResult({
    mediaItemId,
    mediaType,
    provider,
    source: 'scrape-job',
    ...PluginResultSchema.parse({ payload: { tags }, normalized: { tags } }),
  })
}

async function findTag(
  name: string,
  kind = 'keyword',
  mediaType: 'album' | 'film' = 'film',
) {
  const [row] = await databaseClient
    .select()
    .from(schema.tag)
    .where(
      and(
        eq(schema.tag.mediaType, mediaType),
        eq(schema.tag.name, name),
        eq(schema.tag.kind, kind),
      ),
    )
  if (!row) throw new Error(`Missing fixture tag ${name}`)
  return row
}

beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network requests are forbidden in integration tests')
    }),
  )
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  const migrations = readMigrationFiles({
    migrationsFolder: './drizzle',
  })
  const tagMigrationIndex = migrations.findIndex((migration) =>
    migration.sql.some((statement) =>
      statement.includes('CREATE TABLE "tag_occurrence"'),
    ),
  )
  if (tagMigrationIndex === -1)
    throw new Error('Missing tag migration in upgrade fixture')
  // Run the actual generated SQL with pre-existing rows, not only on an empty DB.
  await databaseClient.transaction(async (transaction) => {
    for (const migration of migrations.slice(0, tagMigrationIndex))
      for (const statement of migration.sql)
        await transaction.execute(sql.raw(statement))
  })
  await addMedia('legacy-film')
  // Seed the historical table before later migrations add columns.
  await databaseClient.execute(sql`insert into tag (id, name, kind) values
    ('legacy-a', ${'caf\u00e9 society'}, 'keyword'),
    ('legacy-b', ${' CAFE\u0301\u00a0 Society\t'}, 'keyword'),
    ('legacy-c', 'cafe society', 'keyword'),
    ('legacy-genre', ${'caf\u00e9 society'}, 'genre')`)
  await databaseClient.insert(schema.mediaItemTag).values(
    ['legacy-a', 'legacy-b', 'legacy-c', 'legacy-genre'].map((tagId) => ({
      mediaItemId: 'legacy-film',
      tagId,
    })),
  )
  await databaseClient.insert(schema.providerSnapshot).values({
    id: 'legacy-snapshot',
    mediaItemId: 'legacy-film',
    provider: 'fixture',
    source: 'legacy-import',
    checksum: 'original-checksum',
    payload: { original: 'raw legacy tokens' },
    normalizedData: {
      tags: [{ name: ' CAFE\u0301\u00a0 Society\t', kind: 'keyword' }],
    },
  })
  await databaseClient.transaction(async (transaction) => {
    for (const migration of migrations.slice(tagMigrationIndex))
      for (const statement of migration.sql)
        await transaction.execute(sql.raw(statement))
  })
  await databaseClient
    .insert(schema.user)
    .values({ id: 'tag-user', name: 'Tag reviewer', email: 'tags@example.com' })
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

describe('temporary Postgres tag provenance and media-scoped merges', () => {
  it('hides whole groups reversibly without changing stored memberships or provenance', async () => {
    const { listTags, setTagVisibility, getTagDetail } =
      await import('@/services/tags')
    const { listBrowseFacets, queryBrowseIds } =
      await import('@/services/browse')
    const { getFilmDetail, getAlbumDetail, listFilms, listAlbums } =
      await import('@/services/media')
    await addMedia('hidden-film')
    await addMedia('hidden-album', 'album')
    const token = {
      name: 'Hidden fixture',
      kind: 'keyword',
      source: 'tmdb',
      sourceId: '77',
    }
    await applyTags('hidden-film', [token])
    await applyTags('hidden-album', [token], 'tmdb', 'album')
    const original = await findTag(token.name)
    await databaseClient.insert(schema.tag).values({
      id: 'hidden-cross-kind',
      mediaType: 'film',
      name: ' HIDDEN fixture ',
      kind: 'genre',
    })
    await databaseClient
      .insert(schema.mediaItemTag)
      .values({ mediaItemId: 'hidden-film', tagId: 'hidden-cross-kind' })
    const beforeMemberships = await databaseClient
      .select()
      .from(schema.mediaItemTag)
      .where(
        inArray(schema.mediaItemTag.tagId, [original.id, 'hidden-cross-kind']),
      )
    const beforeOrigins = await databaseClient
      .select()
      .from(schema.tagOccurrence)
      .where(eq(schema.tagOccurrence.tagId, original.id))
    const beforeSnapshots = await databaseClient
      .select()
      .from(schema.providerSnapshot)
      .where(
        inArray(schema.providerSnapshot.mediaItemId, [
          'hidden-film',
          'hidden-album',
        ]),
      )
    expect(
      await setTagVisibility({
        mediaType: 'film',
        tagIds: [original.id],
        hidden: true,
      }),
    ).toEqual({ updated: 1, hidden: true })
    expect(
      await setTagVisibility({
        mediaType: 'film',
        tagIds: [original.id],
        hidden: true,
      }),
    ).toEqual({ updated: 0, hidden: true })
    expect(
      (await listTags(TagListQuerySchema.parse({ q: 'Hidden fixture' }))).items,
    ).toEqual([])
    const hiddenPage = await listTags(
      TagListQuerySchema.parse({ q: 'Hidden fixture', visibility: 'hidden' }),
    )
    expect(hiddenPage.items).toHaveLength(1)
    expect(hiddenPage.items[0]).toMatchObject({ hidden: true, mediaCount: 1 })
    expect(
      (
        await listTags(
          TagListQuerySchema.parse({ q: 'Hidden fixture', visibility: 'all' }),
        )
      ).items,
    ).toEqual(hiddenPage.items)
    expect((await getFilmDetail('hidden-film'))?.tags).toEqual([])
    expect((await getAlbumDetail('hidden-album'))?.tags).toEqual([
      { name: token.name, kind: token.kind },
    ])
    expect(
      (await listFilms(FilmQuerySchema.parse({ q: 'hidden-film' }))).items.find(
        (item) => item.id === 'hidden-film',
      )?.tags,
    ).toEqual([])
    expect(
      (
        await listAlbums(AlbumQuerySchema.parse({ q: 'hidden-album' }))
      ).items.find((item) => item.id === 'hidden-album')?.tags,
    ).toEqual([{ name: token.name, kind: token.kind }])
    const mediaTypes: Array<'film' | 'album'> = ['film', 'album']
    for (const mediaType of mediaTypes) {
      expect(
        (await listBrowseFacets(mediaType)).some(
          (facet) => facet.value === 'hidden fixture',
        ),
      ).toBe(mediaType === 'album')
    }
    // Existing explicit tag filters remain usable; hiding is not membership deletion.
    expect(
      (
        await queryBrowseIds(
          'film',
          FilmQuerySchema.parse({ tag: 'Hidden fixture' }),
        )
      ).ids,
    ).toContain('hidden-film')
    const detail = await getTagDetail(original.id, {
      mediaType: 'film',
      page: 1,
      size: 25,
    })
    expect(detail.tag.hidden).toBe(true)
    expect(detail.provenance.items).toHaveLength(1)
    expect(detail.provenance.tagId).toBe(detail.tag.id)
    expect(
      await databaseClient
        .select()
        .from(schema.mediaItemTag)
        .where(
          inArray(schema.mediaItemTag.tagId, [
            original.id,
            'hidden-cross-kind',
          ]),
        ),
    ).toEqual(beforeMemberships)
    expect(
      await databaseClient
        .select()
        .from(schema.tagOccurrence)
        .where(eq(schema.tagOccurrence.tagId, original.id)),
    ).toEqual(beforeOrigins)
    expect(
      await databaseClient
        .select()
        .from(schema.providerSnapshot)
        .where(
          inArray(schema.providerSnapshot.mediaItemId, [
            'hidden-film',
            'hidden-album',
          ]),
        ),
    ).toEqual(beforeSnapshots)
    expect(
      await setTagVisibility({
        mediaType: 'film',
        tagIds: [original.id],
        hidden: false,
      }),
    ).toEqual({ updated: 1, hidden: false })
    expect((await getFilmDetail('hidden-film'))?.tags).toHaveLength(2)
    expect(
      (await listTags(TagListQuerySchema.parse({ q: 'Hidden fixture' }))).items,
    ).toHaveLength(1)
    expect(
      (await listBrowseFacets('film')).some(
        (facet) => facet.value === 'hidden fixture',
      ),
    ).toBe(true)
  })

  it('preserves hidden state through imports, concurrent merges and subsequent alias imports', async () => {
    const { setTagVisibility, mergeTags, getTagDetail, listTags } =
      await import('@/services/tags')
    const { applyProviderResult } = await import('@/services/provider-state')
    await addMedia('hidden-import-film')
    const sourceToken = { name: 'Hidden merge source', kind: 'keyword' }
    const targetToken = { name: 'Visible merge target', kind: 'keyword' }
    await applyTags('hidden-import-film', [sourceToken, targetToken])
    const source = await findTag(sourceToken.name)
    const target = await findTag(targetToken.name)
    await setTagVisibility({
      mediaType: 'film',
      tagIds: [source.id],
      hidden: true,
    })
    await applyProviderResult({
      mediaItemId: 'hidden-import-film',
      mediaType: 'film',
      provider: 'fixture',
      source: 'legacy-import',
      ...PluginResultSchema.parse({
        payload: { tags: [sourceToken] },
        normalized: { tags: [sourceToken] },
      }),
    })
    expect(
      (await getTagDetail(source.id, { mediaType: 'film', page: 1, size: 25 }))
        .tag.hidden,
    ).toBe(true)
    await Promise.all([
      mergeTags(
        { mediaType: 'film', sourceIds: [source.id], targetId: target.id },
        'tag-user',
      ),
      applyTags('hidden-import-film', [sourceToken]),
    ])
    const detail = await getTagDetail(source.id, {
      mediaType: 'film',
      page: 1,
      size: 1,
    })
    expect(detail.tag).toMatchObject({
      id: target.id,
      hidden: true,
      sourceCount: 3,
    })
    expect(detail.aliases).toEqual([
      { id: source.id, name: source.name, kind: source.kind },
    ])
    expect(detail.provenance.totalCount).toBe(3)
    expect(detail.provenance.items).toHaveLength(1)
    expect(
      (await getTagDetail(target.id, { mediaType: 'film', page: 2, size: 1 }))
        .provenance.items,
    ).toHaveLength(1)
    await applyTags(
      'hidden-import-film',
      [{ ...sourceToken, kind: 'genre' }],
      'mdblist',
    )
    expect(
      (await listTags(TagListQuerySchema.parse({ q: target.name }))).items,
    ).toEqual([])
    await expect(
      setTagVisibility({
        mediaType: 'film',
        tagIds: [source.id],
        hidden: false,
      }),
    ).rejects.toMatchObject({ response: { statusCode: 409 } })
    await expect(
      setTagVisibility({
        mediaType: 'film',
        tagIds: [target.id, 'missing'],
        hidden: false,
      }),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
    expect(
      (await getTagDetail(target.id, { mediaType: 'film', page: 1, size: 25 }))
        .tag.hidden,
    ).toBe(true)
    await setTagVisibility({
      mediaType: 'film',
      tagIds: [target.id],
      hidden: false,
    })
    await applyTags('hidden-import-film', [sourceToken], 'mdblist')
    expect(
      (await getTagDetail(source.id, { mediaType: 'film', page: 1, size: 25 }))
        .tag.hidden,
    ).toBe(false)
    await expect(
      getTagDetail('missing', { mediaType: 'film', page: 1, size: 25 }),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('upgrades existing tags without losing memberships, raw names or snapshot history', async () => {
    const { listTags } = await import('@/services/tags')
    const rows = await databaseClient
      .select()
      .from(schema.mediaItemTag)
      .where(eq(schema.mediaItemTag.mediaItemId, 'legacy-film'))
    expect(rows.map((row) => row.tagId).sort()).toEqual([
      'legacy-a',
      'legacy-c',
      'legacy-genre',
    ])
    const upgradedTags = await databaseClient
      .select()
      .from(schema.tag)
      .where(
        inArray(
          schema.tag.id,
          rows.map((row) => row.tagId),
        ),
      )
    expect(upgradedTags.every((row) => row.hidden === false)).toBe(true)
    const occurrences = await databaseClient
      .select()
      .from(schema.tagOccurrence)
      .where(eq(schema.tagOccurrence.mediaItemId, 'legacy-film'))
    expect(occurrences).toHaveLength(4)
    expect(
      occurrences.every(
        (row) =>
          row.provider === null && row.source === null && row.sourceId === null,
      ),
    ).toBe(true)
    expect(
      occurrences.find((row) => row.rawName === ' CAFE\u0301\u00a0 Society\t')
        ?.tagId,
    ).toBe('legacy-a')
    const [snapshot] = await databaseClient
      .select()
      .from(schema.providerSnapshot)
      .where(eq(schema.providerSnapshot.id, 'legacy-snapshot'))
    expect(snapshot).toMatchObject({
      id: 'legacy-snapshot',
      checksum: 'original-checksum',
      payload: { original: 'raw legacy tokens' },
      normalizedData: {
        tags: [{ name: ' CAFE\u0301\u00a0 Society\t', kind: 'keyword' }],
      },
    })
    expect(
      (await listTags(TagListQuerySchema.parse({ q: 'caf' }))).totalCount,
    ).toBe(2)
    await applyTags('legacy-film', [
      {
        name: 'CAF\u00c9\u2003SOCIETY',
        kind: 'keyword',
        source: 'tmdb',
        sourceId: '42',
        rawName: 'CAF\u00c9\u2003SOCIETY',
      },
    ])
    const [identity] = await databaseClient
      .select()
      .from(schema.tagIdentity)
      .where(
        and(
          eq(schema.tagIdentity.kind, 'keyword'),
          eq(schema.tagIdentity.normalizedName, 'caf\u00e9 society'),
        ),
      )
    expect(identity?.tagId).toBe('legacy-a')
    const canonical = (
      await listTags(TagListQuerySchema.parse({ q: 'caf\u00e9 society' }))
    ).items[0]
    expect(canonical).toMatchObject({
      id: 'legacy-a',
      mediaCount: 1,
      sourceCount: 2,
    })
    expect(canonical?.sources.some((source) => source.provider === null)).toBe(
      true,
    )
    const retained = await databaseClient
      .select()
      .from(schema.tagOccurrence)
      .where(eq(schema.tagOccurrence.mediaItemId, 'legacy-film'))
    for (const original of occurrences)
      expect(retained.find((row) => row.id === original.id)).toEqual(original)
  })

  it('deduplicates equivalent names across providers while preserving distinct provenance and every scrape snapshot', async () => {
    const { listTags } = await import('@/services/tags')
    await addMedia('origins-film')
    const tmdb = {
      name: 'History of Spain',
      kind: 'keyword',
      source: 'tmdb',
      sourceId: '005',
      rawName: 'History of Spain',
    }
    const mdblist = {
      name: ' history\u00a0 of SPAIN ',
      kind: 'keyword',
      source: 'imdb',
      sourceId: 'mdblist:5',
      rawName: 'imdb.history-of-spain',
    }
    await applyTags('origins-film', [tmdb])
    await applyTags(
      'origins-film',
      [
        mdblist,
        { name: 'Spanish history', kind: 'keyword' },
        { name: 'History-of-Spain', kind: 'keyword' },
      ],
      'mdblist',
    )
    await applyTags('origins-film', [tmdb])
    const page = await listTags(
      TagListQuerySchema.parse({ q: 'imdb.history-of-spain' }),
    )
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      name: 'History of Spain',
      mediaCount: 1,
      sourceCount: 2,
    })
    expect(page.items[0]?.sources).toEqual(
      expect.arrayContaining([
        {
          provider: 'tmdb',
          source: 'tmdb',
          sourceId: '005',
          rawName: 'History of Spain',
          kind: 'keyword',
        },
        {
          provider: 'mdblist',
          source: 'imdb',
          sourceId: 'mdblist:5',
          rawName: 'imdb.history-of-spain',
          kind: 'keyword',
        },
      ]),
    )
    expect(
      await databaseClient
        .select()
        .from(schema.mediaItemTag)
        .where(eq(schema.mediaItemTag.mediaItemId, 'origins-film')),
    ).toHaveLength(3)
    const snapshots = await databaseClient
      .select()
      .from(schema.providerSnapshot)
      .where(eq(schema.providerSnapshot.mediaItemId, 'origins-film'))
    expect(snapshots).toHaveLength(3)
    expect(
      snapshots.some((snapshot) =>
        JSON.stringify(snapshot.normalizedData).includes(
          'imdb.history-of-spain',
        ),
      ),
    ).toBe(true)
    expect(
      (await listTags(TagListQuerySchema.parse({ q: '%' }))).totalCount,
    ).toBe(0)
  })

  it('moves memberships and provenance transactionally and keeps old genre/keyword URLs equivalent', async () => {
    const { listTags, mergeTags } = await import('@/services/tags')
    const { queryBrowseIds, listBrowseFacets } =
      await import('@/services/browse')
    await addMedia('merge-a')
    await addMedia('merge-b')
    const old = {
      name: 'Old historical theme',
      kind: 'genre',
      source: 'imdb',
      rawName: 'imdb.old-historical-theme',
    }
    const targetTag = {
      name: 'Historical theme',
      kind: 'keyword',
      source: 'tmdb',
      sourceId: '900',
      rawName: 'Historical theme',
    }
    await applyTags('merge-a', [
      old,
      targetTag,
      { name: 'Unrelated genre', kind: 'genre' },
    ])
    await applyTags('merge-b', [old], 'mdblist')
    const source = await findTag(old.name, old.kind)
    const target = await findTag(targetTag.name)
    const snapshots = await databaseClient
      .select()
      .from(schema.providerSnapshot)
      .where(
        inArray(schema.providerSnapshot.mediaItemId, ['merge-a', 'merge-b']),
      )
    expect(
      await mergeTags(
        { mediaType: 'film', sourceIds: [source.id], targetId: target.id },
        'tag-user',
      ),
    ).toEqual({ merged: 1, targetId: target.id })
    expect(
      await databaseClient
        .select()
        .from(schema.providerSnapshot)
        .where(
          inArray(schema.providerSnapshot.mediaItemId, ['merge-a', 'merge-b']),
        ),
    ).toEqual(snapshots)
    expect(
      await databaseClient
        .select()
        .from(schema.mediaItemTag)
        .where(eq(schema.mediaItemTag.tagId, source.id)),
    ).toEqual([])
    expect(
      await databaseClient
        .select()
        .from(schema.tagOccurrence)
        .where(eq(schema.tagOccurrence.tagId, source.id)),
    ).toEqual([])
    expect(
      await databaseClient
        .select()
        .from(schema.tagMerge)
        .where(eq(schema.tagMerge.sourceTagId, source.id)),
    ).toEqual([
      expect.objectContaining({
        sourceTagId: source.id,
        targetTagId: target.id,
        requestedByUserId: 'tag-user',
        createdAt: expect.any(Date),
      }),
    ])
    await applyTags('merge-b', [old], 'mdblist')
    expect(
      await databaseClient
        .select()
        .from(schema.mediaItemTag)
        .where(eq(schema.mediaItemTag.tagId, source.id)),
    ).toEqual([])
    const page = await listTags(TagListQuerySchema.parse({ q: old.name }))
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      id: target.id,
      name: target.name,
      kind: 'tag',
      mergedNames: [old.name],
      mediaCount: 2,
      sourceCount: 3,
    })
    expect(
      page.items[0]?.sources.filter((origin) => origin.kind === 'genre'),
    ).toHaveLength(2)
    for (const field of ['genre', 'keyword']) {
      for (const value of [target.name, old.name]) {
        const result = await queryBrowseIds(
          'film',
          FilmQuerySchema.parse({
            filters: JSON.stringify([{ field, value }]),
          }),
        )
        expect(result.ids.sort()).toEqual(['merge-a', 'merge-b'])
      }
    }
    const unrelated = await queryBrowseIds(
      'film',
      FilmQuerySchema.parse({
        filters: JSON.stringify([{ field: 'genre', value: 'Unrelated genre' }]),
      }),
    )
    expect(unrelated.ids).toEqual(['merge-a'])
    expect(
      await queryBrowseIds(
        'film',
        FilmQuerySchema.parse({
          filters: JSON.stringify([
            { field: 'keyword', value: 'Unrelated genre' },
          ]),
        }),
      ),
    ).toMatchObject({ ids: ['merge-a'] })
    const facets = await listBrowseFacets('film')
    expect(facets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'genre',
          value: target.name.toLowerCase(),
          count: 2,
        }),
      ]),
    )
    expect(facets.some((facet) => facet.field === 'keyword')).toBe(false)
    expect(facets.some((facet) => facet.value === old.name)).toBe(false)
    await addMedia('late-album', 'album')
    await applyTags('late-album', [old], 'fixture', 'album')
    expect(
      await databaseClient
        .select()
        .from(schema.providerSnapshot)
        .where(eq(schema.providerSnapshot.mediaItemId, 'late-album')),
    ).toHaveLength(1)
  })

  it('flattens chained merges, rejects cycles/stale IDs, and rolls back missing selections', async () => {
    const { mergeTags } = await import('@/services/tags')
    await addMedia('chain-film')
    const tags = ['Chain A', 'Chain B', 'Chain C'].map((name) => ({
      name,
      kind: 'keyword',
    }))
    await applyTags('chain-film', tags)
    const a = await findTag('Chain A')
    const b = await findTag('Chain B')
    const c = await findTag('Chain C')
    await mergeTags(
      { mediaType: 'film', sourceIds: [a.id], targetId: b.id },
      null,
    )
    await mergeTags(
      { mediaType: 'film', sourceIds: [b.id], targetId: c.id },
      null,
    )
    expect(
      (
        await databaseClient
          .select()
          .from(schema.tagAlias)
          .where(inArray(schema.tagAlias.sourceTagId, [a.id, b.id]))
      ).map((row) => row.targetTagId),
    ).toEqual([c.id, c.id])
    await expect(
      mergeTags({ mediaType: 'film', sourceIds: [c.id], targetId: a.id }, null),
    ).rejects.toMatchObject({ response: { statusCode: 409 } })
    await expect(
      mergeTags(
        {
          mediaType: 'film',
          sourceIds: [c.id, 'missing'],
          targetId: 'legacy-a',
        },
        null,
      ),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
    await applyTags('chain-film', tags)
    expect(
      await databaseClient
        .select()
        .from(schema.mediaItemTag)
        .where(eq(schema.mediaItemTag.mediaItemId, 'chain-film')),
    ).toEqual([{ mediaItemId: 'chain-film', tagId: c.id }])
    expect(
      await databaseClient
        .select()
        .from(schema.tagOccurrence)
        .where(eq(schema.tagOccurrence.mediaItemId, 'chain-film')),
    ).toHaveLength(3)
  })

  it('allows cross-kind album merges and keeps every kind visible as Tags', async () => {
    const { mergeTags } = await import('@/services/tags')
    const { queryBrowseIds, listBrowseFacets } =
      await import('@/services/browse')
    await addMedia('album-tags', 'album')
    await applyTags(
      'album-tags',
      [
        { name: 'Album ambient', kind: 'genre' },
        { name: 'Album atmospheric', kind: 'genre' },
        { name: 'Album keyword', kind: 'keyword' },
      ],
      'fixture',
      'album',
    )
    const source = await findTag('Album ambient', 'genre', 'album')
    const target = await findTag('Album atmospheric', 'genre', 'album')
    const keyword = await findTag('Album keyword', 'keyword', 'album')
    await mergeTags(
      { mediaType: 'album', sourceIds: [keyword.id], targetId: target.id },
      'tag-user',
    )
    await mergeTags(
      { mediaType: 'album', sourceIds: [source.id], targetId: target.id },
      'tag-user',
    )
    await applyTags(
      'album-tags',
      [{ name: source.name, kind: 'genre' }],
      'fixture',
      'album',
    )
    expect(
      (
        await queryBrowseIds(
          'album',
          AlbumQuerySchema.parse({ tag: target.name }),
        )
      ).ids,
    ).toEqual(['album-tags'])
    expect(
      (
        await queryBrowseIds(
          'album',
          AlbumQuerySchema.parse({ tag: source.name }),
        )
      ).ids,
    ).toEqual(['album-tags'])
    const facets = await listBrowseFacets('album')
    expect(
      facets.some(
        (facet) => facet.value === keyword.name || facet.value === source.name,
      ),
    ).toBe(false)
    expect(
      facets.some((facet) => facet.value === target.name.toLowerCase()),
    ).toBe(true)
  })

  it('bounds source previews and pagination without undercounting distinct origins', async () => {
    const { listTags } = await import('@/services/tags')
    await addMedia('many-origins')
    await applyTags(
      'many-origins',
      Array.from({ length: 23 }, (_, index) => ({
        name: 'Many origins',
        kind: 'keyword',
        source: 'tmdb',
        sourceId: String(index),
        rawName: `Raw token ${index}`,
      })),
    )
    const page = await listTags(
      TagListQuerySchema.parse({ q: 'Many origins', size: 1 }),
    )
    expect(page).toMatchObject({
      totalCount: 1,
      pageCount: 1,
      page: 1,
      size: 1,
    })
    expect(page.items[0]).toMatchObject({ sourceCount: 23, mediaCount: 1 })
    expect(page.items[0]?.sources).toHaveLength(20)
    expect(
      await listTags(
        TagListQuerySchema.parse({ q: 'Many origins', page: 2, size: 1 }),
      ),
    ).toMatchObject({
      items: [],
      totalCount: 1,
      pageCount: 1,
      page: 2,
      size: 1,
    })
    expect(
      await listTags(
        TagListQuerySchema.parse({ q: 'No matching source fixture' }),
      ),
    ).toMatchObject({ items: [], totalCount: 0, pageCount: 0 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rolls back every moved row if audit insertion fails and serializes concurrent rescrapes', async () => {
    const { mergeTags } = await import('@/services/tags')
    await addMedia('atomic-film')
    const sourceTag = { name: 'Atomic source', kind: 'keyword' }
    await applyTags('atomic-film', [
      sourceTag,
      { name: 'Atomic target', kind: 'keyword' },
    ])
    const source = await findTag(sourceTag.name)
    const target = await findTag('Atomic target')
    const before = await databaseClient
      .select()
      .from(schema.tagOccurrence)
      .where(eq(schema.tagOccurrence.mediaItemId, 'atomic-film'))
    await expect(
      mergeTags(
        { mediaType: 'film', sourceIds: [source.id], targetId: target.id },
        'missing-user',
      ),
    ).rejects.toThrow()
    expect(
      await databaseClient
        .select()
        .from(schema.tagOccurrence)
        .where(eq(schema.tagOccurrence.mediaItemId, 'atomic-film')),
    ).toEqual(before)
    expect(
      await databaseClient
        .select()
        .from(schema.tagAlias)
        .where(eq(schema.tagAlias.sourceTagId, source.id)),
    ).toEqual([])
    expect(
      await databaseClient
        .select()
        .from(schema.mediaItemTag)
        .where(eq(schema.mediaItemTag.mediaItemId, 'atomic-film')),
    ).toHaveLength(2)
    await Promise.all([
      mergeTags(
        { mediaType: 'film', sourceIds: [source.id], targetId: target.id },
        'tag-user',
      ),
      applyTags('atomic-film', [sourceTag], 'mdblist'),
      applyTags('atomic-film', [sourceTag]),
    ])
    expect(
      await databaseClient
        .select()
        .from(schema.mediaItemTag)
        .where(eq(schema.mediaItemTag.mediaItemId, 'atomic-film')),
    ).toEqual([{ mediaItemId: 'atomic-film', tagId: target.id }])
    const after = await databaseClient
      .select()
      .from(schema.tagOccurrence)
      .where(eq(schema.tagOccurrence.mediaItemId, 'atomic-film'))
    expect(after).toHaveLength(3)
    expect(after.every((row) => row.tagId === target.id)).toBe(true)
  })

  it('serves every merged origin with item-specific attribution, pagination and no provider calls', async () => {
    const { getTagProvenance, mergeTags } = await import('@/services/tags')
    await addMedia('source-detail-a')
    await addMedia('source-detail-b')
    await applyTags(
      'source-detail-a',
      [
        {
          name: 'Detail old name',
          kind: 'keyword',
          source: 'imdb',
          rawName: 'imdb.detail-old-name',
          sourceId: 'mdblist:123',
        },
      ],
      'mdblist',
    )
    await applyTags(
      'source-detail-b',
      Array.from({ length: 26 }, (_, index) => ({
        name: 'Detail merged tag',
        kind: 'keyword',
        source: 'tmdb',
        rawName: `Original ${index}`,
        sourceId: String(index + 1),
      })),
    )
    const old = await findTag('Detail old name')
    const target = await findTag('Detail merged tag')
    await mergeTags(
      { mediaType: 'film', sourceIds: [old.id], targetId: target.id },
      'tag-user',
    )
    const query = {
      mediaId: 'source-detail-a',
      name: 'Detail merged tag',
      page: 1,
      size: 25,
    }
    const first = await getTagProvenance(query)
    expect(first.totalCount).toBe(27)
    expect(first.items).toHaveLength(25)
    expect(first.items[0]).toMatchObject({
      rawName: 'imdb.detail-old-name',
      onMedia: true,
      sourceId: 'mdblist:123',
      linkKind: 'tag',
    })
    expect(first.items[0]?.link?.url).toBe(
      'https://www.imdb.com/search/title/?keywords=detail-old-name',
    )
    expect(first.items.slice(1).every((item) => !item.onMedia)).toBe(true)
    const second = await getTagProvenance({ ...query, page: 2 })
    expect(second.items).toHaveLength(2)
    expect(
      new Set([...first.items, ...second.items].map((item) => item.rawName))
        .size,
    ).toBe(27)
    await expect(
      getTagProvenance({ ...query, mediaId: 'missing' }),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('unifies historical cross-kind names, counts distinct films, and merges the complete displayed group', async () => {
    const { listTags, getTagProvenance, mergeTags } =
      await import('@/services/tags')
    const { queryBrowseIds, listBrowseFacets } =
      await import('@/services/browse')
    await addMedia('cross-kind-a')
    await addMedia('cross-kind-b')
    await databaseClient.insert(schema.tag).values([
      {
        id: 'cross-kind-genre',
        mediaType: 'film',
        name: 'Cross Kind',
        kind: 'genre',
      },
      {
        id: 'cross-kind-keyword',
        mediaType: 'film',
        name: ' cross\u00a0 KIND ',
        kind: 'keyword',
      },
    ])
    await databaseClient.insert(schema.tagIdentity).values([
      {
        normalizedName: 'cross kind',
        mediaType: 'film',
        kind: 'genre',
        tagId: 'cross-kind-genre',
      },
      {
        normalizedName: 'cross kind',
        mediaType: 'film',
        kind: 'keyword',
        tagId: 'cross-kind-keyword',
      },
    ])
    await databaseClient.insert(schema.mediaItemTag).values([
      { mediaItemId: 'cross-kind-a', tagId: 'cross-kind-genre' },
      { mediaItemId: 'cross-kind-a', tagId: 'cross-kind-keyword' },
      { mediaItemId: 'cross-kind-b', tagId: 'cross-kind-keyword' },
    ])
    await databaseClient.insert(schema.tagOccurrence).values([
      {
        id: 'cross-origin-a',
        mediaItemId: 'cross-kind-a',
        tagId: 'cross-kind-genre',
        provider: 'tmdb',
        source: 'tmdb',
        rawName: 'Cross Kind',
        kind: 'genre',
      },
      {
        id: 'cross-origin-b',
        mediaItemId: 'cross-kind-b',
        tagId: 'cross-kind-keyword',
        provider: 'mdblist',
        source: 'unknown',
        sourceId: 'mdblist:555',
        rawName: 'unattributed-token',
        kind: 'keyword',
      },
    ])
    await databaseClient.insert(schema.providerReference).values({
      id: 'cross-ref',
      mediaItemId: 'cross-kind-b',
      provider: 'omdb',
      referenceType: 'imdb',
      externalId: 'tt0111161',
    })
    const page = await listTags(TagListQuerySchema.parse({ q: 'Cross' }))
    expect(page.items).toHaveLength(1)
    const group = page.items[0]
    if (!group) throw new Error('Missing tag group')
    expect(group).toMatchObject({
      mediaCount: 2,
      sourceCount: 2,
      mergedNames: [],
    })
    for (const field of ['genre', 'keyword', 'tag']) {
      const query = FilmQuerySchema.parse({
        filters: JSON.stringify([{ field, value: ' CROSS\u2003KIND ' }]),
      })
      expect((await queryBrowseIds('film', query)).ids.sort()).toEqual([
        'cross-kind-a',
        'cross-kind-b',
      ])
    }
    expect(
      (await listBrowseFacets('film')).filter(
        (facet) => facet.value === 'cross kind',
      ),
    ).toEqual([
      {
        field: 'genre',
        value: 'cross kind',
        label: 'Tags: cross kind',
        count: 2,
      },
    ])
    const provenance = await getTagProvenance({
      mediaType: 'film',
      name: group.name,
      page: 1,
      size: 1,
    })
    const second = await getTagProvenance({
      mediaType: 'film',
      name: group.name,
      page: 2,
      size: 1,
    })
    expect(provenance.totalCount).toBe(2)
    expect(provenance.items[0]?.onMedia).toBeNull()
    const fallback = [...provenance.items, ...second.items].find(
      (item) => item.provider === 'mdblist',
    )
    expect(fallback).toMatchObject({
      linkKind: 'provider-item',
      itemTitle: 'cross-kind-b',
      link: { url: 'https://mdblist.com/movie/tt0111161', provider: 'mdblist' },
    })
    await applyTags('cross-kind-a', [
      { name: 'Unified destination', kind: 'general' },
    ])
    const target = await findTag('Unified destination', 'general')
    await mergeTags(
      { mediaType: 'film', sourceIds: [group.id], targetId: target.id },
      'tag-user',
    )
    const merged = await listTags(TagListQuerySchema.parse({ q: 'Cross' }))
    expect(merged.items).toHaveLength(1)
    expect(merged.items[0]).toMatchObject({
      id: target.id,
      mediaCount: 2,
      mergedNames: [' cross\u00a0 KIND ', 'Cross Kind'],
    })
    await applyTags('cross-kind-b', [{ name: 'CROSS KIND', kind: 'general' }])
    expect(
      (
        await databaseClient
          .select()
          .from(schema.mediaItemTag)
          .where(eq(schema.mediaItemTag.mediaItemId, 'cross-kind-b'))
      ).every((row) => row.tagId === target.id),
    ).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('links Discogs genres and legacy styles from item-scoped history and current raw data without writes', async () => {
    const { getTagProvenance } = await import('@/services/tags')
    await addMedia('discogs-source-a', 'album')
    await addMedia('discogs-source-b', 'album')
    await applyTags(
      'discogs-source-a',
      [
        { name: 'Electronic', kind: 'genre', source: 'discogs' },
        { name: 'Arena Rock', kind: 'genre', source: 'discogs' },
        { name: 'Pop', kind: 'genre', source: 'discogs' },
      ],
      'discogs',
      'album',
    )
    await applyTags(
      'discogs-source-b',
      [{ name: 'Arena Rock', kind: 'genre', source: 'discogs' }],
      'discogs',
      'album',
    )
    await databaseClient.insert(schema.externalLink).values({
      id: 'discogs-item-fallback',
      mediaItemId: 'discogs-source-a',
      provider: 'discogs',
      label: 'Discogs',
      url: 'https://www.discogs.com/master/4358199',
    })
    await databaseClient.insert(schema.providerSnapshot).values([
      {
        id: 'discogs-old-style',
        mediaItemId: 'discogs-source-a',
        provider: 'legacy-record',
        source: 'legacy-import',
        checksum: 'discogs-old-style',
        payload: {
          discogs: { master: { styles: ['Arena Rock'] } },
          styles: ['Pop'],
        },
      },
      {
        id: 'discogs-other-item',
        mediaItemId: 'discogs-source-b',
        provider: 'discogs',
        source: 'scrape-job',
        checksum: 'discogs-other-item',
        payload: { release: { genres: ['Arena Rock'] } },
      },
    ])
    await databaseClient
      .update(schema.providerCurrentState)
      .set({
        payload: {
          master: { genres: ['Electronic'] },
          mainRelease: { genres: ['Pop'] },
        },
      })
      .where(
        and(
          eq(schema.providerCurrentState.mediaItemId, 'discogs-source-a'),
          eq(schema.providerCurrentState.provider, 'discogs'),
        ),
      )
    const before = await databaseClient
      .select()
      .from(schema.tagOccurrence)
      .where(eq(schema.tagOccurrence.mediaItemId, 'discogs-source-a'))
    const snapshots = await databaseClient
      .select()
      .from(schema.providerSnapshot)
      .where(eq(schema.providerSnapshot.mediaItemId, 'discogs-source-a'))
    for (const [name, query] of [
      ['Electronic', 'genre=Electronic'],
      ['Pop', 'genre=Pop'],
      ['Arena Rock', 'style=Arena+Rock'],
    ]) {
      if (!name || !query) throw new Error('Missing Discogs fixture')
      const page = await getTagProvenance({
        mediaId: 'discogs-source-a',
        name,
        page: 1,
        size: 25,
      })
      expect(page.items[0]).toMatchObject({
        kind: 'genre',
        onMedia: true,
        linkKind: 'tag',
        link: {
          provider: 'discogs',
          url: `https://www.discogs.com/search?${query}`,
        },
      })
      expect(page.items[0]?.itemTitle).toBeUndefined()
    }
    const other = await getTagProvenance({
      mediaId: 'discogs-source-b',
      name: 'Arena Rock',
      page: 1,
      size: 25,
    })
    expect(other.items[0]?.link?.url).toBe(
      'https://www.discogs.com/search?genre=Arena+Rock',
    )
    expect(
      await databaseClient
        .select()
        .from(schema.tagOccurrence)
        .where(eq(schema.tagOccurrence.mediaItemId, 'discogs-source-a')),
    ).toEqual(before)
    expect(
      await databaseClient
        .select()
        .from(schema.providerSnapshot)
        .where(eq(schema.providerSnapshot.mediaItemId, 'discogs-source-a')),
    ).toEqual(snapshots)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('recovers missing TMDb IDs from old snapshots without rewriting provenance or requesting metadata', async () => {
    const { getTagProvenance } = await import('@/services/tags')
    await addMedia('snapshot-tag-film')
    await applyTags('snapshot-tag-film', [
      { name: 'Snapshot drama', kind: 'genre', source: 'tmdb' },
    ])
    await databaseClient.insert(schema.providerSnapshot).values({
      id: 'old-tmdb-tag-snapshot',
      mediaItemId: 'snapshot-tag-film',
      provider: 'tmdb',
      source: 'scrape-job',
      checksum: 'old-tmdb-tags',
      payload: { genres: [{ id: 18, name: 'Snapshot drama' }] },
    })
    const before = await databaseClient
      .select()
      .from(schema.tagOccurrence)
      .where(eq(schema.tagOccurrence.mediaItemId, 'snapshot-tag-film'))
    const page = await getTagProvenance({
      mediaType: 'film',
      name: 'Snapshot drama',
      page: 1,
      size: 25,
    })
    expect(page.items[0]).toMatchObject({
      linkKind: 'tag',
      link: {
        provider: 'tmdb',
        providerLabel: 'TMDb',
        url: 'https://www.themoviedb.org/genre/18-snapshot-drama/movie',
      },
      linkNote: 'TMDb ID recovered from saved provider data.',
    })
    expect(page.items[0]?.sourceId).toBeUndefined()
    expect(
      await databaseClient
        .select()
        .from(schema.tagOccurrence)
        .where(eq(schema.tagOccurrence.mediaItemId, 'snapshot-tag-film')),
    ).toEqual(before)
    expect(fetch).not.toHaveBeenCalled()
  })
})
