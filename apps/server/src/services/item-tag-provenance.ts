import { and, eq, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import { artistTagFallbackThreshold } from '@repo/schemas/music-tags'
import {
  ItemTagProvenanceQuerySchema,
  TagReleaseSupportSchema,
  normalizeTagName,
  type ItemTagProvenancePage,
  type ItemTagProvenanceQuery,
} from '@repo/schemas/tags'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import {
  sourceLink,
  sourceProviderLabel,
  tagSourceUrl,
} from '@/lib/source-navigation'
import { listLoadedScrapePlugins } from '@/plugins/registry'
import { libraryTrack, mediaItem } from '@/schemas/db'
import { loadArtistTagEvidence, releaseTagMemberships } from './music-tags'
import { normalizedTagSql } from './tag-state'
import { getReleaseTagProvenance } from './tags'

function tagNotFound() {
  return new ServerError({
    statusCode: 404,
    message: 'Tag not found on this item',
  })
}

async function readArtistEvidence(
  scope: { artistId: string } | { mediaId: string },
  name: string,
  query: ItemTagProvenanceQuery,
): Promise<ItemTagProvenancePage> {
  const { items, totalCount } = await loadArtistTagEvidence(
    scope,
    name,
    query.page,
    query.size,
  )
  if (!totalCount) throw tagNotFound()
  const plugins = await listLoadedScrapePlugins()
  return {
    originType: 'artist',
    reason: 'artistId' in scope ? 'direct' : 'artist-fallback',
    items: items.map((item) => {
      const manifest = plugins.find(
        ({ manifest }) => manifest.id === item.provider,
      )?.manifest
      const label = sourceProviderLabel(
        item.provider,
        manifest?.displayName ?? null,
      )
      const source = {
        provider: item.provider,
        source: null,
        rawName: item.rawName,
        kind: 'tag',
      }
      const itemLink = sourceLink(
        item.provider,
        label,
        item.artistName,
        item.url ?? undefined,
      )
      const tagLink = itemLink
        ? null
        : sourceLink(
            item.provider,
            label,
            item.rawName,
            tagSourceUrl(source, manifest),
          )
      const releaseSupport = TagReleaseSupportSchema.safeParse(
        item.releaseSupport,
      )
      return {
        ...source,
        providerLabel: label,
        onMedia: true,
        link: itemLink ?? tagLink,
        linkKind: itemLink ? 'item' : tagLink ? 'tag' : null,
        itemTitle: itemLink ? item.artistName : undefined,
        jobId: item.jobId ?? undefined,
        originType: 'artist',
        originId: item.artistId,
        originTitle: item.artistName,
        snapshotId: item.snapshotId,
        releaseSupport: releaseSupport.success
          ? releaseSupport.data
          : undefined,
      }
    }),
    page: query.page,
    size: query.size,
    totalCount,
    pageCount: Math.ceil(totalCount / query.size),
  }
}

const TrackTagRowsSchema = z.array(
  z.object({
    tagId: z.string(),
    title: z.string(),
    owner: z.enum(['added', 'removed']).nullable(),
    ownerChangedAt: z.string().nullable(),
    sonovault: z.boolean(),
    verified: z.boolean(),
    total: z.number().int().nonnegative(),
    occurrences: z.array(
      z.object({
        source: z.string().nullable(),
        rawName: z.string(),
        sourceId: z.string().nullable(),
        kind: z.string(),
      }),
    ),
  }),
)

/**
 * TTAG-11: why a track carries a tag of its own. Sonovault's names behind the
 * tag on this track, and the owner's change, if any.
 */
async function readTrackTag(
  trackId: string,
  name: string,
  query: ItemTagProvenanceQuery,
): Promise<ItemTagProvenancePage> {
  const result = await db.execute(sql`
    with target as (
      select tt.tag_id, tt.owner, tt.owner_changed_at, tt.sonovault, tt.verified, m.title
      from track_tag tt join tag t on t.id = tt.tag_id
      join media_item m on m.id = tt.media_item_id
      where tt.media_item_id = ${trackId} and t.media_type = 'album'
        and ${normalizedTagSql(sql`t.name`)} = ${name}
      order by tt.in_browse desc, t.id limit 1
    ), names as (
      select o.source, o.raw_name, o.source_id, o.kind from tag_occurrence o
      where o.media_item_id = ${trackId} and o.provider = 'sonovault'
        and o.tag_id = (select tag_id from target)
    )
    select target.tag_id as "tagId", target.title, target.owner,
      to_char(target.owner_changed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "ownerChangedAt",
      target.sonovault, target.verified,
      (select count(*)::int from names) as total,
      coalesce((select jsonb_agg(jsonb_build_object('source', page.source,
          'rawName', page.raw_name, 'sourceId', page.source_id, 'kind', page.kind)
          order by page.kind, page.raw_name)
        from (select * from names order by kind, raw_name, source_id
          limit ${query.size} offset ${(query.page - 1) * query.size}) page), '[]'::jsonb) as occurrences
    from target`)
  const [row] = TrackTagRowsSchema.parse(result.rows)
  if (!row) throw tagNotFound()
  const providerLabel = sourceProviderLabel('sonovault', 'Sonovault')
  return {
    mediaType: 'album',
    tagId: row.tagId,
    originType: 'track',
    reason: 'track',
    trackTag: {
      owner: row.owner,
      ownerChangedAt: row.ownerChangedAt,
      sonovault: row.sonovault,
      verified: row.verified,
    },
    items: row.occurrences.map((occurrence) => ({
      provider: 'sonovault',
      source: occurrence.source,
      rawName: occurrence.rawName,
      ...(occurrence.sourceId === null
        ? {}
        : { sourceId: occurrence.sourceId }),
      kind: occurrence.kind,
      providerLabel,
      onMedia: true,
      link: null,
      linkKind: null,
      originType: 'track',
      originId: trackId,
      originTitle: row.title,
    })),
    page: query.page,
    size: query.size,
    totalCount: row.total,
    pageCount: Math.ceil(row.total / query.size),
  }
}

async function readVisibleAlbumTags(albumId: string, name: string) {
  const rows = await db.execute(sql`
    select coalesce(bool_or(name_key = ${name}), false) as "hasTag",
      count(*)::int as "tagCount"
    from (${releaseTagMemberships(sql`${albumId}`)}) tags
  `)
  const [summary] = z
    .tuple([z.object({ hasTag: z.boolean(), tagCount: z.number() })])
    .parse(rows.rows)
  return summary
}

export async function getItemTagProvenance(
  input: ItemTagProvenanceQuery,
): Promise<ItemTagProvenancePage> {
  const query = ItemTagProvenanceQuerySchema.parse(input)
  const { resourceType, resourceId } = query
  const name = normalizeTagName(query.name)
  if (!name) throw tagNotFound()

  if (resourceType === 'artist') {
    return readArtistEvidence({ artistId: resourceId }, name, query)
  }
  if (query.level === 'track') {
    if (resourceType !== 'track') throw tagNotFound()
    return readTrackTag(resourceId, name, query)
  }

  const albumItem = alias(mediaItem, 'linked_album')
  const [record] = await db
    .select({
      id: mediaItem.id,
      title: mediaItem.title,
      linkedAlbum: { id: albumItem.id, title: albumItem.title },
    })
    .from(mediaItem)
    .leftJoin(libraryTrack, eq(libraryTrack.mediaItemId, mediaItem.id))
    .leftJoin(
      albumItem,
      and(
        eq(albumItem.id, libraryTrack.albumMediaItemId),
        eq(albumItem.mediaType, 'album'),
      ),
    )
    .where(
      and(eq(mediaItem.id, resourceId), eq(mediaItem.mediaType, resourceType)),
    )
  if (!record) throw tagNotFound()

  const linkedAlbum =
    resourceType === 'track' ? (record.linkedAlbum ?? undefined) : undefined
  const album = resourceType === 'album' ? record : linkedAlbum
  const releaseTags = album ? await readVisibleAlbumTags(album.id, name) : null
  const release =
    resourceType === 'film' ? record : releaseTags?.hasTag ? album : undefined
  if (release) {
    const type = resourceType === 'film' ? 'film' : 'album'
    const provenance = await getReleaseTagProvenance(
      { id: release.id, type },
      query,
    )
    return {
      ...provenance,
      originType: type,
      reason: linkedAlbum ? 'linked-album' : 'direct',
      linkedAlbum,
      items: provenance.items.map((item) => ({
        ...item,
        originType: type,
        originId: release.id,
        originTitle: release.title,
      })),
    }
  }
  if ((releaseTags?.tagCount ?? 0) >= artistTagFallbackThreshold) {
    throw tagNotFound()
  }
  return readArtistEvidence({ mediaId: record.id }, name, query)
}
