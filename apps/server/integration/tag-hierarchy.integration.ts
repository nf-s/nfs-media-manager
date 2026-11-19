import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ArtistQuerySchema } from '@repo/schemas/creators'
import { AlbumQuerySchema, FilmQuerySchema } from '@repo/schemas/media'
import { TrackQuerySchema } from '@repo/schemas/tracks'
import { TagListQuerySchema } from '@repo/schemas/tags'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const database = `tag_hierarchy_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database, statement_timeout: 10000 })
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

const albumTags = {
  'a-shoegaze': ['shoegaze'],
  'a-both': ['dream-pop', 'shoegaze'],
  'a-rock': ['rock'],
  'a-jazz': ['jazz'],
  'a-blackgaze': ['blackgaze'],
  'a-artist-only': [],
}

async function albumIds(value: string, mode = 'required', field = 'genre') {
  const { queryBrowseIds } = await import('@/services/browse')
  const result = await queryBrowseIds(
    'album',
    AlbumQuerySchema.parse({
      filters: JSON.stringify([{ field, value, mode }]),
    }),
  )
  return result.ids.sort()
}

async function albumFacets() {
  const { listBrowseFacets } = await import('@/services/browse')
  return listBrowseFacets('album', { limitPerField: 50 })
}

async function albumFacet(value: string, field = 'genre') {
  return (await albumFacets()).find(
    (facet) => facet.field === field && facet.value === value,
  )?.count
}

async function hierarchy(mediaType: 'album' | 'film' = 'album') {
  const { getTagHierarchy } = await import('@/services/tag-hierarchy')
  const result = await getTagHierarchy({ mediaType })
  return {
    ...result,
    byId: new Map(result.nodes.map((node) => [node.id, node])),
  }
}

async function setParents(
  tagIds: string[],
  parentIds: string[],
  mode: 'replace' | 'add' | 'remove' = 'add',
) {
  const { setTagParents } = await import('@/services/tag-hierarchy')
  return setTagParents({ mediaType: 'album', tagIds, parentIds, mode })
}

beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden in tag hierarchy tests')
    }),
  )
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
  await databaseClient.insert(schema.tag).values([
    { id: 'rock', name: 'Rock', mediaType: 'album', kind: 'genre' },
    { id: 'shoegaze', name: 'Shoegaze', mediaType: 'album', kind: 'genre' },
    { id: 'dream-pop', name: 'Dream Pop', mediaType: 'album', kind: 'genre' },
    { id: 'blackgaze', name: 'Blackgaze', mediaType: 'album', kind: 'genre' },
    { id: 'jazz', name: 'Jazz', mediaType: 'album', kind: 'genre' },
    { id: 'film-rock', name: 'Rock', mediaType: 'film', kind: 'keyword' },
    { id: 'film-concert', name: 'Concert', mediaType: 'film', kind: 'keyword' },
  ])
  for (const [id, tags] of Object.entries(albumTags)) {
    const trackId = id.replace('a-', 't-')
    await databaseClient.insert(schema.mediaItem).values([
      { id, slug: id, title: id, mediaType: 'album' },
      { id: trackId, slug: trackId, title: trackId, mediaType: 'track' },
    ])
    await databaseClient.insert(schema.album).values({ mediaItemId: id })
    await databaseClient
      .insert(schema.libraryTrack)
      .values({ mediaItemId: trackId, albumMediaItemId: id })
    if (tags.length)
      await databaseClient
        .insert(schema.mediaItemTag)
        .values(tags.map((tagId) => ({ mediaItemId: id, tagId })))
  }
  await databaseClient
    .insert(schema.artist)
    .values({ id: 'gaze-artist', name: 'Gaze Artist' })
  await databaseClient.insert(schema.artistProviderSnapshot).values({
    id: 'gaze-profile',
    artistId: 'gaze-artist',
    provider: 'lastfm',
    payload: {},
    normalizedData: { tags: ['shoegaze'] },
  })
  await databaseClient.insert(schema.artistProviderCurrentState).values({
    artistId: 'gaze-artist',
    provider: 'lastfm',
    latestSnapshotId: 'gaze-profile',
  })
  await databaseClient.insert(schema.mediaCredit).values({
    mediaItemId: 'a-artist-only',
    artistId: 'gaze-artist',
    role: 'artist',
  })
  await databaseClient.insert(schema.mediaItem).values([
    { id: 'f-rock', slug: 'f-rock', title: 'f-rock', mediaType: 'film' },
    {
      id: 'f-concert',
      slug: 'f-concert',
      title: 'f-concert',
      mediaType: 'film',
    },
  ])
  await databaseClient
    .insert(schema.film)
    .values([{ mediaItemId: 'f-rock' }, { mediaItemId: 'f-concert' }])
  await databaseClient.insert(schema.mediaItemTag).values([
    { mediaItemId: 'f-rock', tagId: 'film-rock' },
    { mediaItemId: 'f-concert', tagId: 'film-concert' },
  ])
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

describe('tag hierarchy', () => {
  it('matches and counts a parent over every tag beneath it', async () => {
    expect(await albumIds('Rock')).toEqual(['a-rock'])
    await setParents(['shoegaze', 'dream-pop'], ['rock'])
    await setParents(['blackgaze'], ['shoegaze'])

    expect(await albumIds('Rock')).toEqual([
      'a-artist-only',
      'a-blackgaze',
      'a-both',
      'a-rock',
      'a-shoegaze',
    ])
    // The album with only artist tags is not matched on release tags.
    expect(await albumIds('Rock', 'required', 'albumTag')).toEqual([
      'a-blackgaze',
      'a-both',
      'a-rock',
      'a-shoegaze',
    ])
    expect(await albumIds('Shoegaze')).toEqual([
      'a-artist-only',
      'a-blackgaze',
      'a-both',
      'a-shoegaze',
    ])
    expect(await albumIds('Blackgaze')).toEqual(['a-blackgaze'])
    expect(await albumIds('Rock', 'exclude')).toEqual(['a-jazz'])

    expect(await albumFacet('rock')).toBe(5)
    expect(await albumFacet('rock', 'albumTag')).toBe(4)
    expect(await albumFacet('rock', 'artistTag')).toBe(1)
    expect(await albumFacet('shoegaze')).toBe(4)
    expect(await albumFacet('dream pop')).toBe(1)
    expect(await albumFacet('jazz')).toBe(1)
    const facets = await albumFacets()
    const subtags = (value: string) =>
      facets.find((facet) => facet.field === 'genre' && facet.value === value)
        ?.subtags
    expect(subtags('rock')).toBe(3)
    expect(subtags('shoegaze')).toBe(1)
    expect(subtags('jazz')).toBeUndefined()

    const { queryBrowseIds } = await import('@/services/browse')
    const tracks = await queryBrowseIds(
      'track',
      TrackQuerySchema.parse({
        filters: JSON.stringify([{ field: 'albumTag', value: 'Rock' }]),
      }),
    )
    expect(tracks.ids.sort()).toEqual([
      't-blackgaze',
      't-both',
      't-rock',
      't-shoegaze',
    ])
  })

  it('matches and counts artists on a parent over every tag beneath it', async () => {
    const profiles = {
      'rock-artist': 'Rock',
      'blackgaze-artist': 'Blackgaze',
      'jazz-artist': 'Jazz',
    }
    for (const [artistId, tag] of Object.entries(profiles)) {
      const trackId = `t-${artistId}`
      await databaseClient
        .insert(schema.mediaItem)
        .values({
          id: trackId,
          slug: trackId,
          title: trackId,
          mediaType: 'track',
        })
      await databaseClient
        .insert(schema.libraryTrack)
        .values({ mediaItemId: trackId })
      await databaseClient
        .insert(schema.artist)
        .values({ id: artistId, name: artistId })
      await databaseClient.insert(schema.artistProviderSnapshot).values({
        id: `${artistId}-profile`,
        artistId,
        provider: 'lastfm',
        payload: {},
        normalizedData: { tags: [tag] },
      })
      await databaseClient.insert(schema.artistProviderCurrentState).values({
        artistId,
        provider: 'lastfm',
        latestSnapshotId: `${artistId}-profile`,
      })
      await databaseClient
        .insert(schema.mediaCredit)
        .values({ mediaItemId: trackId, artistId, role: 'artist' })
    }
    const { listArtistBrowsePage, countArtistBrowse, listArtistBrowseFacets } =
      await import('@/services/artist-browse')
    const query = (value: string, mode = 'required') =>
      ArtistQuerySchema.parse({ filters: [{ field: 'genre', value, mode }] })
    const artistIds = async (value: string, mode?: string) =>
      (await listArtistBrowsePage(query(value, mode))).items
        .map((item) => item.id)
        .sort()

    expect(await artistIds('Rock')).toEqual([
      'blackgaze-artist',
      'gaze-artist',
      'rock-artist',
    ])
    expect(await countArtistBrowse(query('Rock'))).toEqual({ totalCount: 3 })
    expect(await artistIds('Shoegaze')).toEqual([
      'blackgaze-artist',
      'gaze-artist',
    ])
    expect(await artistIds('Blackgaze')).toEqual(['blackgaze-artist'])
    expect(await artistIds('Rock', 'exclude')).toEqual(['jazz-artist'])

    const facets = await listArtistBrowseFacets({ limitPerField: 50 })
    const facet = (value: string) =>
      facets.find((row) => row.field === 'genre' && row.value === value)
    expect(facet('rock')).toMatchObject({ count: 3, subtags: 3 })
    expect(facet('shoegaze')).toMatchObject({ count: 2, subtags: 1 })
    expect(facet('blackgaze')?.count).toBe(1)
    expect(facet('jazz')?.count).toBe(1)
    expect(facet('jazz')?.subtags).toBeUndefined()

    const { setTagVisibility } = await import('@/services/tags')
    await setTagVisibility({
      mediaType: 'album',
      tagIds: ['blackgaze'],
      hidden: true,
    })
    expect(await artistIds('Rock')).toEqual(['gaze-artist', 'rock-artist'])
    // Naming the hidden tag itself still finds its artists.
    expect(await artistIds('Blackgaze')).toEqual(['blackgaze-artist'])
    const hiddenFacets = await listArtistBrowseFacets({ limitPerField: 50 })
    expect(
      hiddenFacets.find((row) => row.field === 'genre' && row.value === 'rock'),
    ).toMatchObject({ count: 2, subtags: 2 })
    await setTagVisibility({
      mediaType: 'album',
      tagIds: ['blackgaze'],
      hidden: false,
    })
  })

  it('lists placed tags with parents, own counts and rolled-up counts', async () => {
    const tree = await hierarchy()
    expect(tree.nodes.map((node) => node.name)).toEqual([
      'Blackgaze',
      'Dream Pop',
      'Rock',
      'Shoegaze',
    ])
    expect(tree.byId.get('rock')).toMatchObject({
      mediaCount: 1,
      totalCount: 4,
      parentIds: [],
    })
    expect(tree.byId.get('shoegaze')).toMatchObject({
      mediaCount: 2,
      totalCount: 3,
      parentIds: ['rock'],
    })
    expect(tree.byId.get('blackgaze')?.parentIds).toEqual(['shoegaze'])
    expect(tree.unplacedCount).toBe(1)

    const { listTags } = await import('@/services/tags')
    const all = await listTags(TagListQuerySchema.parse({ mediaType: 'album' }))
    const shoegaze = all.items.find((item) => item.id === 'shoegaze')
    expect(shoegaze?.parents).toEqual([{ id: 'rock', name: 'Rock' }])
    expect(shoegaze?.childCount).toBe(1)
    const unplaced = await listTags(
      TagListQuerySchema.parse({ mediaType: 'album', placement: 'unplaced' }),
    )
    expect(unplaced.items.map((item) => item.name)).toEqual(['Jazz'])

    const { getTagDetail } = await import('@/services/tags')
    const detail = await getTagDetail('rock', {
      mediaType: 'album',
      page: 1,
      size: 25,
    })
    expect(detail.children).toEqual([
      { id: 'dream-pop', name: 'Dream Pop' },
      { id: 'shoegaze', name: 'Shoegaze' },
    ])
  })

  it('keeps the album and film hierarchies apart', async () => {
    const { queryBrowseIds } = await import('@/services/browse')
    const films = await queryBrowseIds(
      'film',
      FilmQuerySchema.parse({
        filters: JSON.stringify([{ field: 'genre', value: 'Rock' }]),
      }),
    )
    expect(films.ids).toEqual(['f-rock'])
    expect((await hierarchy('film')).nodes).toEqual([])
    await expect(setParents(['film-concert'], ['rock'])).rejects.toMatchObject({
      response: { statusCode: 404 },
    })
    const { setTagParents } = await import('@/services/tag-hierarchy')
    await setTagParents({
      mediaType: 'film',
      tagIds: ['film-concert'],
      parentIds: ['film-rock'],
      mode: 'add',
    })
    expect(
      (
        await queryBrowseIds(
          'film',
          FilmQuerySchema.parse({
            filters: JSON.stringify([{ field: 'genre', value: 'Rock' }]),
          }),
        )
      ).ids.sort(),
    ).toEqual(['f-concert', 'f-rock'])
    // The album tag of the same name gained nothing from the film link.
    expect((await hierarchy()).byId.get('rock')?.totalCount).toBe(4)
  })

  it('leaves hidden subtags out of a parent', async () => {
    const { setTagVisibility } = await import('@/services/tags')
    await setTagVisibility({
      mediaType: 'album',
      tagIds: ['blackgaze'],
      hidden: true,
    })
    expect(await albumIds('Rock')).not.toContain('a-blackgaze')
    expect(await albumFacet('rock')).toBe(4)
    expect((await hierarchy()).byId.get('rock')?.totalCount).toBe(3)
    // Naming the hidden tag itself still finds its items.
    expect(await albumIds('Blackgaze')).toEqual(['a-blackgaze'])
    await setTagVisibility({
      mediaType: 'album',
      tagIds: ['blackgaze'],
      hidden: false,
    })
    expect(await albumFacet('rock')).toBe(5)
  })

  it('rejects a tag placed beneath its own subtag and keeps the links', async () => {
    await expect(setParents(['rock'], ['blackgaze'])).rejects.toMatchObject({
      response: { statusCode: 409 },
    })
    await expect(
      setParents(['rock'], ['rock'], 'replace'),
    ).rejects.toBeDefined()
    expect((await hierarchy()).byId.get('rock')?.parentIds).toEqual([])
    expect(await albumIds('Blackgaze')).toEqual(['a-blackgaze'])
  })

  it('creates grouping tags and replaces or removes parents', async () => {
    const { createTag } = await import('@/services/tag-hierarchy')
    const genres = await createTag({ mediaType: 'album', name: '  Genres ' })
    expect(genres.name).toBe('Genres')
    await expect(
      createTag({ mediaType: 'album', name: 'genres' }),
    ).rejects.toMatchObject({ response: { statusCode: 409 } })
    await expect(
      createTag({ mediaType: 'album', name: 'ROCK' }),
    ).rejects.toMatchObject({ response: { statusCode: 409 } })
    const moods = await createTag({
      mediaType: 'album',
      name: 'Moods',
      parentIds: [genres.id],
    })

    await setParents(['rock', 'jazz'], [genres.id])
    let tree = await hierarchy()
    expect(tree.byId.get(genres.id)).toMatchObject({
      mediaCount: 0,
      totalCount: 5,
    })
    expect(tree.byId.get(moods.id)?.parentIds).toEqual([genres.id])
    expect(tree.unplacedCount).toBe(0)
    expect(await albumIds('Genres')).toHaveLength(6)

    await setParents(['jazz'], [moods.id], 'replace')
    tree = await hierarchy()
    expect(tree.byId.get('jazz')?.parentIds).toEqual([moods.id])
    await setParents(['jazz'], [moods.id], 'remove')
    await setParents(['dream-pop'], [], 'replace')
    tree = await hierarchy()
    expect(tree.byId.has('jazz')).toBe(false)
    expect(tree.byId.has('dream-pop')).toBe(false)
    expect(tree.unplacedCount).toBe(2)
    expect(await albumIds('Rock')).not.toContain('a-jazz')
  })

  it('carries parents and subtags over a merge', async () => {
    await setParents(['dream-pop'], ['rock'])
    await setParents(['jazz'], ['dream-pop'])
    const { mergeTags } = await import('@/services/tags')
    await mergeTags(
      { mediaType: 'album', sourceIds: ['dream-pop'], targetId: 'shoegaze' },
      'tag-user',
    )
    const tree = await hierarchy()
    expect(tree.byId.has('dream-pop')).toBe(false)
    expect(tree.byId.get('jazz')?.parentIds).toEqual(['shoegaze'])
    expect(tree.byId.get('shoegaze')?.parentIds).toEqual(['rock'])
    expect(await albumIds('Shoegaze')).toEqual([
      'a-artist-only',
      'a-blackgaze',
      'a-both',
      'a-jazz',
      'a-shoegaze',
    ])
    // The merged name still resolves, now with the surviving tag's subtags.
    expect(await albumIds('Dream Pop')).toEqual(await albumIds('Shoegaze'))

    // Merging a parent into its own subtag leaves no loop behind.
    await mergeTags(
      { mediaType: 'album', sourceIds: ['rock'], targetId: 'blackgaze' },
      'tag-user',
    )
    const merged = await hierarchy()
    expect(merged.byId.has('rock')).toBe(false)
    const { rows } = await databaseClient.execute(
      "select 1 from tag_ancestor where media_type = 'album' and descendant_key = ancestor_key",
    )
    expect(rows).toEqual([])
  })
})
