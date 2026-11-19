import { and, eq, inArray, notInArray, or, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  CreateTagSchema,
  SetTagParentsSchema,
  TagHierarchyQuerySchema,
  type CreateTagInput,
  type CreateTagResult,
  type SetTagParentsInput,
  type SetTagParentsResult,
  type TagHierarchy,
  type TagHierarchyQuery,
} from '@repo/schemas/tags'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { createDatabaseReadCache } from '@/lib/database-read-cache'
import { createStableId } from '@/lib/media-utils'
import { mergeTagEdges } from '@/lib/tag-hierarchy'
import { tag, tagAlias, tagIdentity, tagParent } from '@/schemas/db'
import {
  lockTagWrites,
  normalizedTagSql,
  normalizeTagName,
  tagDisplayName,
  type TagDatabase,
} from './tag-state'

type TagMediaType = 'album' | 'film'

const hierarchyCache = createDatabaseReadCache<TagHierarchy>({
  maxEntries: 4,
  maxValueBytes: 4 * 1024 * 1024,
})

/** Tag groups hidden from browsing, by normalized name. */
function hiddenTagKey(mediaType: SQL, key: SQL): SQL {
  return sql`exists (select 1 from tag hidden_tag
    where hidden_tag.media_type = ${mediaType} and hidden_tag.hidden
      and ${normalizedTagSql(sql`hidden_tag.name`)} = ${key})`
}

/** Visible tags beneath the given normalized names, as normalized names. */
export function descendantTagNames(mediaType: TagMediaType, names: SQL): SQL {
  return sql`select a.descendant_key from tag_ancestor a
    where a.media_type = ${mediaType} and a.ancestor_key in (${names})
      and not ${hiddenTagKey(sql`a.media_type`, sql`a.descendant_key`)}`
}

/**
 * Each visible tag row with every visible tag above it. Facets add these rows
 * so a parent counts the items that carry any of its subtags.
 */
export function tagAncestorRows(mediaType: TagMediaType): SQL {
  return sql`select t.id as tag_id, a.ancestor_key
    from tag_ancestor a
    join tag t on t.media_type = a.media_type
      and ${normalizedTagSql(sql`t.name`)} = a.descendant_key
    where a.media_type = ${mediaType} and not t.hidden
      and not ${hiddenTagKey(sql`a.media_type`, sql`a.ancestor_key`)}`
}

/** Visible ancestors of normalized names that are not tag rows (artist tags). */
export function tagAncestorKeys(mediaType: TagMediaType): SQL {
  return sql`select a.descendant_key, a.ancestor_key from tag_ancestor a
    where a.media_type = ${mediaType}
      and not ${hiddenTagKey(sql`a.media_type`, sql`a.ancestor_key`)}`
}

const SubtagCountRowsSchema = z.array(
  z.object({ key: z.string(), count: z.coerce.number().int().positive() }),
)

/** How many visible tags sit beneath each of the given normalized names. */
export async function visibleSubtagCounts(
  mediaType: TagMediaType,
  keys: string[],
): Promise<Map<string, number>> {
  if (!keys.length) return new Map()
  const rows = SubtagCountRowsSchema.parse(
    (
      await db.execute(sql`
        select a.ancestor_key as key, count(*) as count from tag_ancestor a
        where a.media_type = ${mediaType}
          and a.ancestor_key = any(${sql.param(keys)}::text[])
          and not ${hiddenTagKey(sql`a.media_type`, sql`a.descendant_key`)}
        group by a.ancestor_key`)
    ).rows,
  )
  return new Map(rows.map((row) => [row.key, row.count]))
}

/** Replace one library's ancestor rows from its parent links. */
export async function rebuildTagAncestors(
  database: TagDatabase,
  mediaType: TagMediaType,
): Promise<void> {
  await database.execute(
    sql`delete from tag_ancestor where media_type = ${mediaType}`,
  )
  // `union` removes repeats, so the walk ends even if a loop was stored.
  await database.execute(sql`
    insert into tag_ancestor (media_type, descendant_key, ancestor_key)
    with recursive walk(descendant_key, ancestor_key) as (
      select child_key, parent_key from tag_parent where media_type = ${mediaType}
      union
      select walk.descendant_key, p.parent_key from walk
      join tag_parent p on p.media_type = ${mediaType} and p.child_key = walk.ancestor_key
    )
    select ${mediaType}, descendant_key, ancestor_key from walk`)
}

async function hasLoop(database: TagDatabase, mediaType: TagMediaType) {
  const result = await database.execute(sql`
    select 1 from tag_ancestor
    where media_type = ${mediaType} and descendant_key = ancestor_key limit 1`)
  return result.rows.length > 0
}

/** Normalized names of the tag groups the given ids belong to. */
async function tagGroupKeys(
  database: TagDatabase,
  mediaType: TagMediaType,
  ids: string[],
): Promise<Map<string, string>> {
  if (!ids.length) return new Map()
  const rows = await database
    .select({ id: tag.id, name: tag.name })
    .from(tag)
    .where(and(eq(tag.mediaType, mediaType), inArray(tag.id, ids)))
  if (rows.length !== new Set(ids).size)
    throw new ServerError({ statusCode: 404, message: 'Tag not found' })
  const aliases = await database
    .select({ id: tagAlias.sourceTagId })
    .from(tagAlias)
    .where(inArray(tagAlias.sourceTagId, ids))
  if (aliases.length)
    throw new ServerError({
      statusCode: 409,
      message: 'A selected tag was already merged. Refresh the tag list.',
    })
  return new Map(rows.map((row) => [row.id, normalizeTagName(row.name)]))
}

function keysFor(ids: string[], keys: Map<string, string>) {
  return [...new Set(ids.flatMap((id) => keys.get(id) ?? []))]
}

async function addParentLinks(
  database: TagDatabase,
  mediaType: TagMediaType,
  children: string[],
  parents: string[],
) {
  if (!children.length || !parents.length) return
  await database
    .insert(tagParent)
    .values(
      children.flatMap((childKey) =>
        parents.map((parentKey) => ({ mediaType, childKey, parentKey })),
      ),
    )
    .onConflictDoNothing()
}

export async function setTagParents(
  input: SetTagParentsInput,
): Promise<SetTagParentsResult> {
  const { mediaType, tagIds, parentIds, mode } =
    SetTagParentsSchema.parse(input)
  return db.transaction(async (database) => {
    await lockTagWrites(database)
    const keys = await tagGroupKeys(database, mediaType, [
      ...tagIds,
      ...parentIds,
    ])
    const children = keysFor(tagIds, keys)
    const parents = keysFor(parentIds, keys)
    if (parents.some((parent) => children.includes(parent)))
      throw new ServerError({
        statusCode: 422,
        message: 'A tag cannot be its own parent',
      })
    const ofChildren = and(
      eq(tagParent.mediaType, mediaType),
      inArray(tagParent.childKey, children),
    )
    if (mode === 'replace')
      await database
        .delete(tagParent)
        .where(
          parents.length
            ? and(ofChildren, notInArray(tagParent.parentKey, parents))
            : ofChildren,
        )
    if (mode === 'remove')
      await database
        .delete(tagParent)
        .where(and(ofChildren, inArray(tagParent.parentKey, parents)))
    else await addParentLinks(database, mediaType, children, parents)
    await rebuildTagAncestors(database, mediaType)
    if (await hasLoop(database, mediaType))
      throw new ServerError({
        statusCode: 409,
        message: 'A tag cannot sit beneath one of its own subtags',
      })
    return { updated: children.length }
  })
}

/** Create a tag with no items, used to group other tags. */
export async function createTag(
  input: CreateTagInput,
): Promise<CreateTagResult> {
  const { mediaType, name, parentIds } = CreateTagSchema.parse(input)
  const displayName = tagDisplayName(name)
  const key = normalizeTagName(name)
  return db.transaction(async (database) => {
    await lockTagWrites(database)
    const [existing] = await database
      .select({ id: tag.id })
      .from(tag)
      .where(
        and(
          eq(tag.mediaType, mediaType),
          sql`${normalizedTagSql(sql`${tag.name}`)} = ${key}`,
        ),
      )
      .limit(1)
    const [identity] = await database
      .select({ tagId: tagIdentity.tagId })
      .from(tagIdentity)
      .where(
        and(
          eq(tagIdentity.mediaType, mediaType),
          eq(tagIdentity.normalizedName, key),
        ),
      )
      .limit(1)
    if (existing || identity)
      throw new ServerError({
        statusCode: 409,
        message: 'A tag with this name already exists in this library',
      })
    const keys = await tagGroupKeys(database, mediaType, parentIds)
    const id = createStableId('tag', `${mediaType}:general:${key}`)
    await database
      .insert(tag)
      .values({ id, mediaType, name: displayName, kind: 'general' })
    // Later provider tags with this name join the created tag.
    await database
      .insert(tagIdentity)
      .values({ mediaType, normalizedName: key, kind: 'general', tagId: id })
    const parents = keysFor(parentIds, keys)
    if (parents.length) {
      await addParentLinks(database, mediaType, [key], parents)
      await rebuildTagAncestors(database, mediaType)
    }
    return { id, name: displayName }
  })
}

/** Carry the hierarchy over when tag groups are merged into one. */
export async function mergeTagParents(
  database: TagDatabase,
  mediaType: TagMediaType,
  sourceKeys: string[],
  targetKey: string,
): Promise<void> {
  const sources = [...new Set(sourceKeys)].filter((key) => key !== targetKey)
  if (!sources.length) return
  const touched = await database
    .select({ child: tagParent.childKey })
    .from(tagParent)
    .where(
      and(
        eq(tagParent.mediaType, mediaType),
        or(
          inArray(tagParent.childKey, sources),
          inArray(tagParent.parentKey, sources),
        ),
      ),
    )
    .limit(1)
  if (!touched.length) return
  const edges = await database
    .select({ child: tagParent.childKey, parent: tagParent.parentKey })
    .from(tagParent)
    .where(eq(tagParent.mediaType, mediaType))
  const stored = new Set(edges.map((edge) => `${edge.child}\n${edge.parent}`))
  const added = mergeTagEdges(edges, sources, targetKey).filter(
    (edge) => !stored.has(`${edge.child}\n${edge.parent}`),
  )
  await database
    .delete(tagParent)
    .where(
      and(
        eq(tagParent.mediaType, mediaType),
        or(
          inArray(tagParent.childKey, sources),
          inArray(tagParent.parentKey, sources),
        ),
      ),
    )
  if (added.length)
    await database
      .insert(tagParent)
      .values(
        added.map((edge) => ({
          mediaType,
          childKey: edge.child,
          parentKey: edge.parent,
        })),
      )
      .onConflictDoNothing()
  await rebuildTagAncestors(database, mediaType)
}

const HierarchyRowsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    hidden: z.boolean(),
    media_count: z.coerce.number().int().nonnegative(),
    total_count: z.coerce.number().int().nonnegative(),
    parent_ids: z.array(z.string()),
  }),
)
const CountRowsSchema = z
  .array(z.object({ count: z.coerce.number().int().nonnegative() }))
  .length(1)

async function readTagHierarchy(
  mediaType: TagMediaType,
): Promise<TagHierarchy> {
  const notMerged = sql`not exists (select 1 from tag_alias merged where merged.source_tag_id = t.id)`
  const placed = sql`select child_key as key from tag_parent where media_type = ${mediaType}
    union select parent_key from tag_parent where media_type = ${mediaType}`
  // Start from the linked names so only their tag rows are read.
  const rows = HierarchyRowsSchema.parse(
    (
      await db.execute(sql`
        with placed as materialized (${placed}),
        members as materialized (
          select placed.key, t.id as tag_id, t.name, t.hidden
          from placed join tag t on t.media_type = ${mediaType}
            and ${normalizedTagSql(sql`t.name`)} = placed.key
          where ${notMerged}
        ),
        nodes as materialized (
          select key, min(tag_id) as id, min(name) as name, bool_or(hidden) as hidden
          from members group by key
        ),
        own as (
          select members.key, count(distinct mt.media_item_id) as count
          from members join media_item_tag mt on mt.tag_id = members.tag_id
          group by members.key
        ),
        visible_items as materialized (
          select distinct members.key, mt.media_item_id
          from members join nodes on nodes.key = members.key and not nodes.hidden
          join media_item_tag mt on mt.tag_id = members.tag_id
        ),
        rolled as (
          select key, media_item_id from visible_items
          union
          select a.ancestor_key, visible_items.media_item_id from visible_items
          join tag_ancestor a on a.media_type = ${mediaType}
            and a.descendant_key = visible_items.key
        ),
        totals as (select key, count(*) as count from rolled group by key)
        select nodes.id, nodes.name, nodes.hidden,
          coalesce(own.count, 0) as media_count,
          coalesce(totals.count, 0) as total_count,
          coalesce((
            select array_agg(parent.id order by lower(parent.name), parent.id)
            from tag_parent p join nodes parent on parent.key = p.parent_key
            where p.media_type = ${mediaType} and p.child_key = nodes.key
          ), '{}') as parent_ids
        from nodes
        left join own on own.key = nodes.key
        left join totals on totals.key = nodes.key
        order by lower(nodes.name), nodes.id`)
    ).rows,
  )
  const [unplaced] = CountRowsSchema.parse(
    (
      await db.execute(sql`
        select count(distinct ${normalizedTagSql(sql`t.name`)}) as count from tag t
        where t.media_type = ${mediaType} and not t.hidden and ${notMerged}
          and ${normalizedTagSql(sql`t.name`)} <> ''
          and ${normalizedTagSql(sql`t.name`)} not in (${placed})`)
    ).rows,
  )
  return {
    mediaType,
    nodes: rows.map((row) => ({
      id: row.id,
      name: row.name,
      hidden: row.hidden,
      mediaCount: row.media_count,
      totalCount: row.total_count,
      parentIds: row.parent_ids,
    })),
    unplacedCount: unplaced?.count ?? 0,
  }
}

export async function getTagHierarchy(
  input: TagHierarchyQuery,
): Promise<TagHierarchy> {
  const { mediaType } = TagHierarchyQuerySchema.parse(input)
  return hierarchyCache(mediaType, () => readTagHierarchy(mediaType))
}
