import type { AlbumListItem } from '@repo/schemas/media'
import { z } from 'zod'
import {
  AlbumHttpUrlSchema,
  AlbumRymUrlSchema,
} from '@/plugins/builtin/album-provider-helpers'

const RatedRymMetadataSchema = z.object({
  browse: z.object({ ratingRymValue: z.number().finite().min(0).max(5) }),
  'plugin.serply.provenance': z.object({
    source: z.literal('rym'),
    retrievalProvider: z.literal('serply'),
    matchStatus: z.literal('rated'),
    ratingSourceUrl: AlbumHttpUrlSchema,
  }),
})

export function rymRatingSourceUrl(metadata: unknown): string | undefined {
  const parsed = RatedRymMetadataSchema.safeParse(metadata)
  if (!parsed.success) return undefined
  const url = parsed.data['plugin.serply.provenance'].ratingSourceUrl
  const base = new URL(url)
  // Validate child pages through their release parent, but link to the exact
  // page that supplied the score rather than its identity or genre source.
  base.pathname = base.pathname.replace(
    /^(\/release\/[^/]+\/[^/]+\/[^/]+)\/(?:reviews|lists)(?:\/\d+)?\/?$/,
    '$1/',
  )
  return AlbumRymUrlSchema.safeParse(base.href).success ? url : undefined
}

export function withRymRatingSourceLink(
  links: AlbumListItem['links'],
  metadata: unknown,
): AlbumListItem['links'] {
  const url = rymRatingSourceUrl(metadata)
  if (!url) return links
  const source = links.find((link) => link.url === url) ?? {
    provider: 'serply',
    label: 'Rate Your Music',
    url,
  }
  return [source, ...links.filter((link) => link.url !== url)]
}
