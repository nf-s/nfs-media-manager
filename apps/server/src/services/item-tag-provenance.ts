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
