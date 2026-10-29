import { and, asc, eq, sql, type SQL } from 'drizzle-orm'
import type { PluginNormalizedResult } from '@repo/media-plugin-sdk'
import { db } from '@/lib/db'
import { createStableId } from '@/lib/media-utils'
import { mediaItemTag, tag, tagIdentity, tagOccurrence } from '@/schemas/db'

export type TagDatabase = Parameters<Parameters<typeof db.transaction>[0]>[0]

export function normalizeTagName(name: string): string {
  return tagDisplayName(name).toLowerCase()
}

export function tagDisplayName(name: string): string {
  return name.normalize('NFC').replace(/\s+/gu, ' ').trim()
}

export function normalizedTagSql(value: SQL): SQL {
  return sql`lower(btrim(regexp_replace(normalize(${value}, NFC), ${'[\\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+'}, ' ', 'g')))`
}

export async function lockTagWrites(database: TagDatabase): Promise<void> {
  // Acquire before media row locks so merges and provider updates cannot deadlock.
  await database.execute(sql`select pg_advisory_xact_lock(72041, 1)`)
}

export async function upsertProviderTags(
  database: TagDatabase,
  mediaItemId: string,
  provider: string,
  mediaType: 'album' | 'film',
  tags: PluginNormalizedResult['tags'],
): Promise<void> {
  for (const item of tags) {
    const normalizedName = normalizeTagName(item.name)
    if (!normalizedName) continue
    const [identity] = await database
      .select({ tagId: tagIdentity.tagId })
      .from(tagIdentity)
      .innerJoin(tag, eq(tag.id, tagIdentity.tagId))
      .where(
        and(
          eq(tagIdentity.mediaType, mediaType),
          eq(tagIdentity.normalizedName, normalizedName),
        ),
      )
      // Existing aliases take precedence for their original kind.
      .orderBy(
        sql`(${tagIdentity.kind} = ${item.kind}) desc`,
        asc(tagIdentity.tagId),
      )
      .limit(1)
    let tagId = identity?.tagId
    if (!tagId) {
      tagId = createStableId(
        'tag',
        `${mediaType}:${item.kind}:${normalizedName}`,
      )
      await database
        .insert(tag)
        .values({
          id: tagId,
          mediaType,
          name: tagDisplayName(item.name),
          kind: item.kind,
        })
        .onConflictDoNothing()
      await database
        .insert(tagIdentity)
        .values({ mediaType, normalizedName, kind: item.kind, tagId })
    }
    await database
      .insert(mediaItemTag)
      .values({ mediaItemId, tagId })
      .onConflictDoNothing()
    const rawName = item.rawName ?? item.name
    const source = item.source ?? null
    const sourceId = item.sourceId ?? null
    await database
      .insert(tagOccurrence)
      .values({
        id: createStableId(
          'tagocc',
          JSON.stringify([
            mediaItemId,
            provider,
            source,
            sourceId,
            rawName,
            item.kind,
            normalizedName,
          ]),
        ),
        mediaItemId,
        tagId,
        provider,
        source,
        sourceId,
        rawName,
        kind: item.kind,
      })
      .onConflictDoUpdate({
        target: tagOccurrence.id,
        set: { tagId, updatedAt: new Date() },
      })
  }
}
