import type { PluginMediaType, PluginReference } from '@repo/media-plugin-sdk'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import {
  AlbumHttpUrlSchema,
  AlbumRymUrlSchema,
} from '@/plugins/builtin/album-provider-helpers'
import { externalLink } from '@/schemas/db'

const LegacyProviderSchema = z.enum(['google-custom-search', 'legacy-browser'])
const LegacyLinkSchema = z.object({
  provider: LegacyProviderSchema,
  url: AlbumHttpUrlSchema.transform((value) => {
    const url = new URL(value)
    // Strip only known children of a complete release path, not a title slug.
    url.pathname = url.pathname.replace(
      /^(\/release\/[^/]+\/[^/]+\/[^/]+)\/(?:reviews|lists)(?:\/\d+)?\/?$/,
      '$1/',
    )
    return url.href
  }).pipe(AlbumRymUrlSchema),
})

export async function getProviderReferenceHints(input: {
  provider: string
  mediaType: PluginMediaType
  mediaItemId: string
  existingReferences: readonly Pick<PluginReference, 'referenceType'>[]
}): Promise<PluginReference[]> {
  if (
    input.provider !== 'serply' ||
    input.mediaType !== 'album' ||
    input.existingReferences.some(
      ({ referenceType }) => referenceType === 'rym-url',
    )
  )
    return []

  const links = await db
    .select({ provider: externalLink.provider, url: externalLink.url })
    .from(externalLink)
    .where(
      and(
        eq(externalLink.mediaItemId, input.mediaItemId),
        inArray(externalLink.provider, LegacyProviderSchema.options),
      ),
    )
    .orderBy(asc(externalLink.id))
    .limit(8)

  const hints: PluginReference[] = []
  const seen = new Set<string>()
  for (const link of links) {
    const parsed = LegacyLinkSchema.safeParse(link)
    if (!parsed.success || seen.has(parsed.data.url)) continue
    seen.add(parsed.data.url)
    hints.push({
      referenceType: 'rym-url',
      externalId: parsed.data.url,
      isPrimary: false,
      metadata: { sourceProvider: parsed.data.provider, searchHint: true },
    })
  }
  return hints
}
