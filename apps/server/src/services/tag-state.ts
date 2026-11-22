import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { PluginNormalizedResult } from '@repo/media-plugin-sdk'
import { db } from '@/lib/db'
import { createStableId } from '@/lib/media-utils'
import { normalizedTagSql } from '@/lib/tag-sql'
import {
  mediaItemTag,
  tag,
  tagAlias,
  tagIdentity,
  tagOccurrence,
} from '@/schemas/db'
import { normalizeTagName, tagDisplayName } from '@repo/schemas/tags'

export type TagDatabase = Parameters<Parameters<typeof db.transaction>[0]>[0]
/** A transaction or the database: what reads and writes of tag rows use. */
export type TagWriter = Pick<
  typeof db,
  'delete' | 'execute' | 'insert' | 'select' | 'update'
>

export { normalizeTagName, tagDisplayName } from '@repo/schemas/tags'

export { normalizedTagSql } from '@/lib/tag-sql'

export async function lockTagWrites(database: TagDatabase): Promise<void> {
  // Acquire before media row locks so merges and provider updates cannot deadlock.
  await database.execute(sql`select pg_advisory_xact_lock(72041, 1)`)
}

/**
 * Track tag writers take this lock shared, before reading tag names. Merging
 * a tag and hiding or showing one take it exclusively (in their triggers), so
 * either the writer's rows are in place before a merge moves rows or a hide
 * recounts tracks, or the writer resolves names after the change.
 */
export async function lockTrackTagWrites(database: TagWriter): Promise<void> {
  await database.execute(sql`select pg_advisory_xact_lock_shared(72041, 2)`)
}

export type ProviderTagName = Pick<
  PluginNormalizedResult['tags'][number],
  'name' | 'kind'
>

/**
 * The tag each provider name joins, in order: the name's identity (one of
 * the same kind first), else a tag of that normalised name, following its
 * merge. A name with neither gets a new visible tag outside the hierarchy;
 * with `create: false` nothing is written and its ID is the one it would get,
 * listed in `created`. An empty name resolves to null.
 */
export async function resolveProviderTagNames(
  database: TagWriter,
  mediaType: 'album' | 'film',
  items: ProviderTagName[],
  { create = true }: { create?: boolean } = {},
): Promise<{ tagIds: (string | null)[]; created: string[] }> {
  const names = [
    ...new Set(
      items.map((item) => normalizeTagName(item.name)).filter(Boolean),
    ),
  ]
  if (!names.length) return { tagIds: items.map(() => null), created: [] }
  const identities = await database
    .select({
      normalizedName: tagIdentity.normalizedName,
      kind: tagIdentity.kind,
      tagId: tagIdentity.tagId,
    })
    .from(tagIdentity)
    .innerJoin(tag, eq(tag.id, tagIdentity.tagId))
    .where(
      and(
        eq(tagIdentity.mediaType, mediaType),
        inArray(tagIdentity.normalizedName, names),
      ),
    )
    .orderBy(asc(tagIdentity.tagId))
  const known = new Map<string, { kind: string; tagId: string }[]>()
  for (const row of identities) {
    const rows = known.get(row.normalizedName) ?? []
    rows.push(row)
    known.set(row.normalizedName, rows)
  }
  const unnamed = names.filter((name) => !known.has(name))
  const byName = new Map<string, string>()
  if (unnamed.length)
    for (const row of await database
      .select({
        normalizedName: sql<string>`${normalizedTagSql(sql`${tag.name}`)}`,
        tagId: sql<string>`coalesce(${tagAlias.targetTagId}, ${tag.id})`,
      })
      .from(tag)
      .leftJoin(tagAlias, eq(tagAlias.sourceTagId, tag.id))
      .where(
        and(
          eq(tag.mediaType, mediaType),
          inArray(normalizedTagSql(sql`${tag.name}`), unnamed),
        ),
      )
      .orderBy(asc(tag.id)))
      if (!byName.has(row.normalizedName))
        byName.set(row.normalizedName, row.tagId)
  const newTags: (typeof tag.$inferInsert)[] = []
  const newIdentities: (typeof tagIdentity.$inferInsert)[] = []
  const tagIds = items.map((item) => {
    const normalizedName = normalizeTagName(item.name)
    if (!normalizedName) return null
    // Existing aliases take precedence for their original kind.
    const rows = known.get(normalizedName)
    const identity = rows?.find((row) => row.kind === item.kind) ?? rows?.[0]
    if (identity) return identity.tagId
    const named = byName.get(normalizedName)
    if (named) return named
    const tagId = createStableId(
      'tag',
      `${mediaType}:${item.kind}:${normalizedName}`,
    )
    newTags.push({
      id: tagId,
      mediaType,
      name: tagDisplayName(item.name),
      kind: item.kind,
    })
    newIdentities.push({ mediaType, normalizedName, kind: item.kind, tagId })
    known.set(normalizedName, [{ kind: item.kind, tagId }])
    return tagId
  })
  if (create && newTags.length) {
    await database.insert(tag).values(newTags).onConflictDoNothing()
    await database
      .insert(tagIdentity)
      .values(newIdentities)
      .onConflictDoNothing()
  }
  return {
    tagIds,
    created: newIdentities.map((identity) => identity.normalizedName),
  }
}

/** The occurrence row recording where one provider name of an item came from. */
export function providerTagOccurrence(
  mediaItemId: string,
  tagId: string,
  provider: string,
  item: PluginNormalizedResult['tags'][number],
): typeof tagOccurrence.$inferInsert {
  const rawName = item.rawName ?? item.name
  const source = item.source ?? null
  const sourceId = item.sourceId ?? null
  return {
    id: createStableId(
      'tagocc',
      JSON.stringify([
        mediaItemId,
        provider,
        source,
        sourceId,
        rawName,
        item.kind,
        normalizeTagName(item.name),
      ]),
    ),
    mediaItemId,
    tagId,
    provider,
    source,
    sourceId,
    rawName,
    kind: item.kind,
  }
}

/** Writes occurrences, moving an existing one to the tag its name joins now. */
export async function upsertTagOccurrences(
  database: TagWriter,
  rows: (typeof tagOccurrence.$inferInsert)[],
): Promise<void> {
  // One statement cannot update a row twice; the last row for an ID wins.
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()]
  for (let start = 0; start < unique.length; start += 1000)
    await database
      .insert(tagOccurrence)
      .values(unique.slice(start, start + 1000))
      .onConflictDoUpdate({
        target: tagOccurrence.id,
        set: { tagId: sql`excluded.tag_id`, updatedAt: new Date() },
        setWhere: sql`${tagOccurrence.tagId} is distinct from excluded.tag_id`,
      })
}

export async function upsertProviderTags(
  database: TagDatabase,
  mediaItemId: string,
  provider: string,
  mediaType: 'album' | 'film',
  tags: PluginNormalizedResult['tags'],
): Promise<void> {
  const { tagIds } = await resolveProviderTagNames(database, mediaType, tags)
  const memberships = [
    ...new Set(tagIds.filter((tagId) => tagId !== null)),
  ].map((tagId) => ({ mediaItemId, tagId }))
  if (!memberships.length) return
  await database.insert(mediaItemTag).values(memberships).onConflictDoNothing()
  await upsertTagOccurrences(
    database,
    tags.flatMap((item, index) => {
      const tagId = tagIds[index]
      return tagId
        ? [providerTagOccurrence(mediaItemId, tagId, provider, item)]
        : []
    }),
  )
}
