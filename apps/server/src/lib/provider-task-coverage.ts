import { sql, type SQL } from 'drizzle-orm'
import type { ProviderTaskLimit } from '@repo/schemas/provider'
import { SONOVAULT_BULK_LIMIT } from '@repo/schemas/sonovault'

/**
 * For providers whose work runs as task jobs rather than item scrapes: how
 * many items one job covers, and which library items they have data for.
 * Providers without an entry are described by their manifest.
 */
type ProviderTaskCoverage = {
  limits: ProviderTaskLimit[]
  coverage: {
    mediaType: 'album' | 'track'
    /** True for a library item (`media_item mi`) the provider has data for. */
    covered: SQL
    /** Where the rest is looked up, as in the coverage response. */
    queueFrom: 'metadata' | 'item'
  }[]
}

const providerTaskCoverage: Record<string, ProviderTaskCoverage> = {
  sonovault: {
    limits: [
      {
        label: 'Track lookups',
        maxItems: SONOVAULT_BULK_LIMIT,
        noun: { one: 'track', other: 'tracks' },
      },
      {
        label: 'Album lookups',
        maxItems: 1,
        noun: { one: 'album', other: 'albums' },
      },
    ],
    coverage: [
      {
        mediaType: 'track',
        covered: sql`mi.id in (select l.media_item_id from sonovault_track_lookup l
          where l.status = 'matched')`,
        queueFrom: 'metadata',
      },
      {
        mediaType: 'album',
        covered: sql`mi.id in (select l.media_item_id from sonovault_album_lookup l
          where l.status = 'confirmed')`,
        queueFrom: 'item',
      },
    ],
  },
}

export function providerTaskLimits(provider: string): ProviderTaskLimit[] {
  return providerTaskCoverage[provider]?.limits ?? []
}

export function providerTaskCoverageSources(provider: string) {
  return providerTaskCoverage[provider]?.coverage ?? null
}
