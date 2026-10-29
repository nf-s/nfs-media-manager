import {
  and,
  asc,
  count,
  eq,
  inArray,
  notExists,
  sql,
  type SQL,
} from 'drizzle-orm'
import { nanoid } from 'nanoid'
import {
  MergeTagsSchema,
  TagListQuerySchema,
  type MergeTagsInput,
  type TagListQuery,
  type TagPage,
  TagProvenanceQuerySchema,
  type TagProvenanceQuery,
  type TagProvenancePage,
  TagParamsSchema,
  TagDetailQuerySchema,
  SetTagVisibilitySchema,
  type TagDetail,
  type TagDetailQuery,
  type SetTagVisibilityInput,
  type SetTagVisibilityResult,
} from '@repo/schemas/tags'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import {
  mediaItem,
  mediaItemTag,
  tag,
  tagAlias,
  tagIdentity,
  tagMerge,
  tagOccurrence,
  externalLink,
  providerReference,
  providerCurrentState,
  providerSnapshot,
} from '@/schemas/db'
import { lockTagWrites, normalizedTagSql, normalizeTagName } from './tag-state'
import { listLoadedScrapePlugins } from '@/plugins/registry'
import { getStoredDiscogsTagPayloads } from './source-navigation'
import {
  sourceLink,
  tagSourceUrl,
  storedItemSourceLink,
  tagSourceProvider,
  sourceProviderLabel,
  storedTmdbTagSourceUrl,
} from '@/lib/source-navigation'

function visibleTagOccurrenceSql(occurrence: SQL): SQL {
  // Hide only redundant migration placeholders, not unresolved items or aliases.
  return sql`not (
    ${occurrence}.provider is null and ${occurrence}.source is null and ${occurrence}.source_id is null
    and exists (
      select 1 from tag_occurrence attributed
      where attributed.media_item_id = ${occurrence}.media_item_id
        and attributed.tag_id = ${occurrence}.tag_id
        and attributed.kind = ${occurrence}.kind
        and ${normalizedTagSql(sql`attributed.raw_name`)} = ${normalizedTagSql(sql`${occurrence}.raw_name`)}
        and (
          coalesce(nullif(lower(btrim(attributed.provider)), 'unknown'), '') <> ''
          or coalesce(nullif(lower(btrim(attributed.source)), 'unknown'), '') <> ''
        )
    )
  )`
}

export async function getTagProvenance(
  input: TagProvenanceQuery,
): Promise<TagProvenancePage> {
  const query = TagProvenanceQuerySchema.parse(input)
  const [media] = query.mediaId
    ? await db
        .select({ mediaType: mediaItem.mediaType })
        .from(mediaItem)
        .where(eq(mediaItem.id, query.mediaId))
        .limit(1)
    : []
  if (
    query.mediaId &&
    (!media || (query.mediaType && query.mediaType !== media.mediaType))
  )
    throw new ServerError({
      statusCode: 404,
      message: 'Media item not found in this library',
    })
  const mediaType = media?.mediaType ?? query.mediaType
  if (!mediaType)
    throw new ServerError({
      statusCode: 422,
      message: 'Provide a media type or media item',
    })
  const memberships = await db
    .select({ id: tag.id })
    .from(tag)
    .where(
      and(
        eq(tag.mediaType, mediaType),
        sql`${normalizedTagSql(sql`${tag.name}`)} = ${normalizeTagName(query.name)}`,
        notExists(
          db
            .select({ id: tagAlias.sourceTagId })
            .from(tagAlias)
            .where(eq(tagAlias.sourceTagId, tag.id)),
        ),
      ),
    )
    .orderBy(asc(tag.id))
  if (!memberships.length)
    throw new ServerError({
      statusCode: 404,
      message: 'Tag not found',
    })
  const tagIds = memberships.map((item) => item.id)
  if (query.mediaId) {
    const [membership] = await db
      .select()
      .from(mediaItemTag)
      .where(
        and(
          eq(mediaItemTag.mediaItemId, query.mediaId),
          inArray(mediaItemTag.tagId, tagIds),
        ),
      )
      .limit(1)
    if (!membership)
      throw new ServerError({
        statusCode: 404,
        message: 'Tag not found on this item',
      })
  }
  const origins = db
    .select({
      provider: tagOccurrence.provider,
      source: tagOccurrence.source,
      rawName: tagOccurrence.rawName,
      sourceId: tagOccurrence.sourceId,
      kind: tagOccurrence.kind,
      onMedia: query.mediaId
        ? sql<
            boolean | null
          >`bool_or(${tagOccurrence.mediaItemId} = ${query.mediaId})`.as(
            'on_media',
          )
        : sql<boolean | null>`null::boolean`.as('on_media'),
      exampleMediaId: query.mediaId
        ? sql<string>`coalesce(min(${tagOccurrence.mediaItemId}) filter (where ${tagOccurrence.mediaItemId} = ${query.mediaId}), min(${tagOccurrence.mediaItemId}))`.as(
            'example_media_id',
          )
        : sql<string>`min(${tagOccurrence.mediaItemId})`.as('example_media_id'),
    })
    .from(tagOccurrence)
    .where(
      and(
        inArray(tagOccurrence.tagId, tagIds),
        visibleTagOccurrenceSql(sql`${tagOccurrence}`),
      ),
    )
    .groupBy(
      tagOccurrence.provider,
      tagOccurrence.source,
      tagOccurrence.rawName,
      tagOccurrence.sourceId,
      tagOccurrence.kind,
    )
    .as('origins')
  const [total] = await db.select({ count: count() }).from(origins)
  const rows = await db
    .select()
    .from(origins)
    .orderBy(
      sql`${origins.onMedia} desc`,
      asc(origins.provider),
      asc(origins.source),
      asc(origins.rawName),
      asc(origins.sourceId),
      asc(origins.kind),
    )
    .limit(query.size)
    .offset((query.page - 1) * query.size)
  const plugins = await listLoadedScrapePlugins()
  const exampleIds = [...new Set(rows.map((row) => row.exampleMediaId))]
  if (!exampleIds.length)
    return {
      mediaType,
      tagId: memberships[0]?.id,
      items: [],
      totalCount: total?.count ?? 0,
      page: query.page,
      size: query.size,
      pageCount: Math.ceil((total?.count ?? 0) / query.size),
    }
  const links = await db
    .select()
    .from(externalLink)
    .where(inArray(externalLink.mediaItemId, exampleIds))
  const references = await db
    .select()
    .from(providerReference)
    .where(inArray(providerReference.mediaItemId, exampleIds))
  const states = await db
    .select({
      mediaItemId: providerCurrentState.mediaItemId,
      provider: providerCurrentState.provider,
      payload: providerCurrentState.payload,
    })
    .from(providerCurrentState)
    .where(
      and(
        inArray(providerCurrentState.mediaItemId, exampleIds),
        eq(providerCurrentState.provider, 'mdblist'),
      ),
    )
  const titles = await db
    .select({ id: mediaItem.id, title: mediaItem.title })
    .from(mediaItem)
    .where(inArray(mediaItem.id, exampleIds))
  const tmdbMediaIds = [
    ...new Set(
      rows
        .filter(
          (row) => tagSourceProvider(row) === 'tmdb' && !tagSourceUrl(row),
        )
        .map((row) => row.exampleMediaId),
    ),
  ]
  // Project only tag arrays, not entire movie payloads. This is a read-only history lookup.
  const tmdbHistory = tmdbMediaIds.length
    ? await db
        .select({
          mediaItemId: providerSnapshot.mediaItemId,
          payload: sql<unknown>`jsonb_build_object('genres', ${providerSnapshot.payload}->'genres', 'keywords', ${providerSnapshot.payload}->'keywords')`,
        })
        .from(providerSnapshot)
        .where(
          and(
            inArray(providerSnapshot.mediaItemId, tmdbMediaIds),
            eq(providerSnapshot.provider, 'tmdb'),
          ),
        )
    : []
  const tmdbCurrent = tmdbMediaIds.length
    ? await db
        .select({
          mediaItemId: providerCurrentState.mediaItemId,
          payload: sql<unknown>`jsonb_build_object('genres', ${providerCurrentState.payload}->'genres', 'keywords', ${providerCurrentState.payload}->'keywords')`,
        })
        .from(providerCurrentState)
        .where(
          and(
            inArray(providerCurrentState.mediaItemId, tmdbMediaIds),
            eq(providerCurrentState.provider, 'tmdb'),
          ),
        )
    : []
  const discogsPayloads = await getStoredDiscogsTagPayloads([
    ...new Set(
      rows
        .filter((row) => tagSourceProvider(row) === 'discogs')
        .map((row) => row.exampleMediaId),
    ),
  ])
  return {
    mediaType,
    tagId: memberships[0]?.id,
    items: rows.map(({ exampleMediaId, ...row }) => {
      const manifest = plugins.find(
        (plugin) => plugin.manifest.id === row.provider,
      )?.manifest
      const providerLabel = manifest?.displayName ?? row.provider
      const directTagUrl = tagSourceUrl(
        row,
        manifest,
        discogsPayloads
          .filter((state) => state.mediaItemId === exampleMediaId)
          .map((state) => state.payload),
      )
      const recoveredTagUrl = directTagUrl
        ? undefined
        : storedTmdbTagSourceUrl(
            row,
            [...tmdbCurrent, ...tmdbHistory]
              .filter((state) => state.mediaItemId === exampleMediaId)
              .map((state) => state.payload),
          )
      const tagUrl = directTagUrl ?? recoveredTagUrl
      const tagProvider = tagSourceProvider(row)
      const itemLink = storedItemSourceLink(
        row,
        links.filter((link) => link.mediaItemId === exampleMediaId),
        references.filter(
          (reference) => reference.mediaItemId === exampleMediaId,
        ),
        states.find((state) => state.mediaItemId === exampleMediaId)?.payload,
        providerLabel,
        manifest,
      )
      const link =
        sourceLink(
          tagProvider ?? 'unknown',
          sourceProviderLabel(
            tagProvider,
            tagProvider === row.provider ? providerLabel : null,
          ),
          row.rawName,
          tagUrl,
        ) ??
        itemLink?.link ??
        null
      return {
        ...row,
        sourceId: row.sourceId ?? undefined,
        providerLabel,
        link,
        linkKind: link ? (tagUrl ? 'tag' : (itemLink?.kind ?? 'item')) : null,
        itemTitle:
          !tagUrl && link
            ? titles.find((item) => item.id === exampleMediaId)?.title
            : undefined,
        linkNote: recoveredTagUrl
          ? 'TMDb ID recovered from saved provider data.'
          : !tagUrl
            ? itemLink
              ? 'No direct tag URL is available; this item contains the original tag.'
              : 'No supported source URL could be resolved from the stored identifiers.'
            : undefined,
      }
    }),
    totalCount: total?.count ?? 0,
    page: query.page,
    size: query.size,
    pageCount: Math.ceil((total?.count ?? 0) / query.size),
  }
}

export async function listTags(input: TagListQuery): Promise<TagPage> {
  return queryTagPage(input)
}

async function queryTagPage(
  input: TagListQuery,
  tagId?: string,
): Promise<TagPage> {
  const query = TagListQuerySchema.parse(input)
  const pattern = `%${(query.q ?? '').trim().replace(/[\\%_]/g, '\\$&')}%`
  // Join distinct matching IDs once; correlated membership subplans can degrade
  // to repeated scans when a broad search outgrows PostgreSQL's hash budget.
  const matching = sql`
    select t.id from tag t where t.media_type = ${query.mediaType} and t.name ilike ${pattern}
    union
    select o.tag_id from tag_occurrence o join tag t on t.id = o.tag_id
      where t.media_type = ${query.mediaType} and o.raw_name ilike ${pattern}
    union
    select i.tag_id from tag_identity i
      where i.media_type = ${query.mediaType} and i.normalized_name ilike ${pattern}
  `
  const groupQuery = db
    .select({
      id: sql<string>`min(${tag.id})`.as('id'),
      name: sql<string>`min(${tag.name})`.as('name'),
      ids: sql<string[]>`array_agg(${tag.id})`.as('ids'),
      hidden: sql<boolean>`bool_or(${tag.hidden})`.as('hidden'),
    })
    .from(tag)
    .where(
      and(
        eq(tag.mediaType, query.mediaType),
        sql`${normalizedTagSql(sql`${tag.name}`)} <> ''`,
        notExists(
          db
            .select({ id: tagAlias.sourceTagId })
            .from(tagAlias)
            .where(eq(tagAlias.sourceTagId, tag.id)),
        ),
      ),
    )
    .$dynamic()
  const groups = (
    query.q?.trim()
      ? groupQuery.leftJoin(
          sql`(${matching}) matching_tags`,
          sql`matching_tags.id = ${tag.id}`,
        )
      : groupQuery
  )
    .groupBy(normalizedTagSql(sql`${tag.name}`))
    // Search selects whole groups, not just the matching kind or spelling.
    .having(
      query.q?.trim() ? sql`bool_or(matching_tags.id is not null)` : undefined,
    )
    .as('tag_groups')
  const groupWhere = and(
    query.visibility === 'all'
      ? undefined
      : eq(groups.hidden, query.visibility === 'hidden'),
    tagId ? sql`${tagId} = any(${groups.ids})` : undefined,
  )
  const rows = await db
    .select({
      totalCount: sql<number>`count(*) over()::integer`,
      id: groups.id,
      name: groups.name,
      hidden: groups.hidden,
      kind: sql<string>`'tag'`,
      mergedNames: sql<
        string[]
      >`array(select distinct original.name from tag_alias a join tag original on original.id = a.source_tag_id where a.target_tag_id = any(${groups.ids}) order by original.name)`,
      mediaCount: sql<number>`(select count(distinct m.media_item_id)::integer from media_item_tag m where m.tag_id = any(${groups.ids}))`,
      sourceCount: sql<number>`(select count(distinct (o.provider, o.source, o.raw_name, o.source_id, o.kind))::integer from tag_occurrence o where o.tag_id = any(${groups.ids}) and ${visibleTagOccurrenceSql(sql`o`)})`,
      sources: sql<
        Array<{
          provider: string | null
          source: string | null
          rawName: string
          sourceId: string | null
          kind: string
        }>
      >`coalesce((select jsonb_agg(s) from (select distinct o.provider, o.source, o.raw_name as "rawName", o.source_id as "sourceId", o.kind from tag_occurrence o where o.tag_id = any(${groups.ids}) and ${visibleTagOccurrenceSql(sql`o`)} order by o.provider, o.source, o.raw_name, o.source_id, o.kind limit 20) s), '[]'::jsonb)`,
    })
    .from(groups)
    .where(groupWhere)
    .orderBy(asc(groups.name), asc(groups.id))
    .limit(query.size)
    .offset((query.page - 1) * query.size)
  // Window counts share the grouping work with the page; an out-of-range page
  // still needs its total even though there is no row carrying the window value.
  const totalCount =
    rows[0]?.totalCount ??
    (await db.select({ count: count() }).from(groups).where(groupWhere))[0]
      ?.count ??
    0
  return {
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      hidden: row.hidden,
      kind: row.kind,
      mergedNames: row.mergedNames,
      mediaCount: row.mediaCount,
      sourceCount: row.sourceCount,
      mediaType: query.mediaType,
      sources: row.sources.map(({ sourceId, ...source }) => ({
        ...source,
        ...(sourceId === null ? {} : { sourceId }),
      })),
    })),
    totalCount,
    page: query.page,
    size: query.size,
    pageCount: Math.ceil(totalCount / query.size),
  }
}

export async function getTagDetail(
  id: string,
  input: TagDetailQuery,
): Promise<TagDetail> {
  TagParamsSchema.parse({ id })
  const query = TagDetailQuerySchema.parse(input)
  const [alias] = await db
    .select()
    .from(tagAlias)
    .where(eq(tagAlias.sourceTagId, id))
  const page = await queryTagPage(
    TagListQuerySchema.parse({ mediaType: query.mediaType, visibility: 'all' }),
    alias?.targetTagId ?? id,
  )
  const summary = page.items[0]
  if (!summary)
    throw new ServerError({ statusCode: 404, message: 'Tag not found' })
  const members = db
    .select({ id: tag.id })
    .from(tag)
    .where(
      and(
        eq(tag.mediaType, query.mediaType),
        sql`${normalizedTagSql(sql`${tag.name}`)} = ${normalizeTagName(summary.name)}`,
        notExists(
          db.select().from(tagAlias).where(eq(tagAlias.sourceTagId, tag.id)),
        ),
      ),
    )
  const aliases = await db
    .select({ id: tag.id, name: tag.name, kind: tag.kind })
    .from(tagAlias)
    .innerJoin(tag, eq(tag.id, tagAlias.sourceTagId))
    .where(inArray(tagAlias.targetTagId, members))
    .orderBy(asc(tag.name), asc(tag.id))
  return {
    tag: summary,
    aliases,
    provenance: await getTagProvenance({ ...query, name: summary.name }),
  }
}

export async function setTagVisibility(
  input: SetTagVisibilityInput,
): Promise<SetTagVisibilityResult> {
  const { tagIds, hidden, mediaType } = SetTagVisibilitySchema.parse(input)
  return db.transaction(async (database) => {
    await lockTagWrites(database)
    const rows = await database
      .select()
      .from(tag)
      .where(and(eq(tag.mediaType, mediaType), inArray(tag.id, tagIds)))
    if (rows.length !== tagIds.length)
      throw new ServerError({ statusCode: 404, message: 'Tag not found' })
    const aliases = await database
      .select()
      .from(tagAlias)
      .where(inArray(tagAlias.sourceTagId, tagIds))
    if (aliases.length)
      throw new ServerError({
        statusCode: 409,
        message: 'A selected tag was already merged. Refresh the tag list.',
      })
    const changed = await database
      .update(tag)
      .set({ hidden, updatedAt: new Date() })
      .where(
        and(
          eq(tag.mediaType, mediaType),
          inArray(
            normalizedTagSql(sql`${tag.name}`),
            rows.map((row) => normalizeTagName(row.name)),
          ),
          eq(tag.hidden, !hidden),
          notExists(
            database
              .select()
              .from(tagAlias)
              .where(eq(tagAlias.sourceTagId, tag.id)),
          ),
        ),
      )
      .returning({ name: tag.name })
    return {
      updated: new Set(changed.map((row) => normalizeTagName(row.name))).size,
      hidden,
    }
  })
}

export async function mergeTags(
  input: MergeTagsInput,
  userId: string | null,
): Promise<{ merged: number; targetId: string }> {
  const {
    sourceIds: selectedSourceIds,
    targetId,
    mediaType,
  } = MergeTagsSchema.parse(input)
  return db.transaction(async (database) => {
    await lockTagWrites(database)
    const ids = [...selectedSourceIds, targetId]
    const rows = await database
      .select()
      .from(tag)
      .where(and(eq(tag.mediaType, mediaType), inArray(tag.id, ids)))
    const target = rows.find((row) => row.id === targetId)
    if (!target || rows.length !== ids.length)
      throw new ServerError({ statusCode: 404, message: 'Tag not found' })
    const aliases = await database
      .select()
      .from(tagAlias)
      .where(inArray(tagAlias.sourceTagId, ids))
    if (aliases.length > 0)
      throw new ServerError({
        statusCode: 409,
        message: 'A selected tag was already merged. Refresh the tag list.',
      })

    const groupedRows = await database
      .select({ id: tag.id, hidden: tag.hidden })
      .from(tag)
      .where(
        and(
          eq(tag.mediaType, mediaType),
          inArray(
            normalizedTagSql(sql`${tag.name}`),
            rows.map((row) => normalizeTagName(row.name)),
          ),
          notExists(
            database
              .select({ id: tagAlias.sourceTagId })
              .from(tagAlias)
              .where(eq(tagAlias.sourceTagId, tag.id)),
          ),
        ),
      )
    const sourceIds = groupedRows
      .map((row) => row.id)
      .filter((id) => id !== targetId)

    // A merge must not silently restore a group the user explicitly hid.
    if (groupedRows.some((row) => row.hidden))
      await database
        .update(tag)
        .set({ hidden: true, updatedAt: new Date() })
        .where(eq(tag.id, targetId))

    // Alias targets are always canonical. Flatten incoming aliases before hiding sources.
    await database
      .update(tagAlias)
      .set({ targetTagId: targetId })
      .where(inArray(tagAlias.targetTagId, sourceIds))
    await database
      .update(tagIdentity)
      .set({ tagId: targetId })
      .where(inArray(tagIdentity.tagId, sourceIds))
    await database
      .insert(mediaItemTag)
      .select(
        database
          .select({
            mediaItemId: mediaItemTag.mediaItemId,
            tagId: sql<string>`${targetId}`.as('tag_id'),
          })
          .from(mediaItemTag)
          .where(inArray(mediaItemTag.tagId, sourceIds)),
      )
      .onConflictDoNothing()
    await database
      .update(tagOccurrence)
      .set({ tagId: targetId })
      .where(inArray(tagOccurrence.tagId, sourceIds))
    await database
      .delete(mediaItemTag)
      .where(inArray(mediaItemTag.tagId, sourceIds))
    await database.insert(tagAlias).values(
      sourceIds.map((sourceTagId) => ({
        sourceTagId,
        targetTagId: targetId,
      })),
    )
    await database.insert(tagMerge).values(
      sourceIds.map((sourceTagId) => ({
        id: nanoid(),
        sourceTagId,
        targetTagId: targetId,
        requestedByUserId: userId,
      })),
    )
    return { merged: sourceIds.length, targetId }
  })
}
