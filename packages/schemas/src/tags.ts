import { z } from 'zod'
import { MediaTypeSchema, PaginatedDataSchema } from './common'

export function tagDisplayName(name: string): string {
  return name.normalize('NFC').replace(/\s+/gu, ' ').trim()
}

export function normalizeTagName(name: string): string {
  return tagDisplayName(name).toLowerCase()
}

/** Words a tag name keeps in lower case unless they start or end it. */
const TAG_MINOR_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'but',
  'by',
  'de',
  'del',
  'du',
  'for',
  'from',
  'in',
  'into',
  'n',
  'nor',
  'of',
  'on',
  'or',
  'the',
  'to',
  'via',
  'vs',
  'with',
])

/** Abbreviations and names whose capitals are not the first letter alone. */
const TAG_FIXED_WORDS = new Map(
  [
    '3D',
    '4K',
    'ADHD',
    'AFI',
    'AI',
    'AIDS',
    'AOR',
    'ATL',
    'BBC',
    'BDSM',
    'C86',
    'CCM',
    'CG',
    'CGI',
    'CIA',
    'DC',
    'DIY',
    'DJ',
    'DMV',
    'DNA',
    'DnB',
    'DVD',
    'EAI',
    'EBM',
    'ECM',
    'EDM',
    'EP',
    'EU',
    'FBI',
    'GDR',
    'HBO',
    'HIV',
    'IDM',
    'II',
    'III',
    'IMAX',
    'IRA',
    'IV',
    'KC',
    'KGB',
    'KKK',
    'LAPD',
    'LGBT',
    'LGBTQ',
    'LP',
    'LSD',
    'MC',
    'MCU',
    'MPB',
    'MTV',
    'NASA',
    'NRG',
    'NSA',
    'NWOBHM',
    'NYC',
    'NYPD',
    'NZ',
    'OC',
    'OCD',
    'OKC',
    'OST',
    'POV',
    'PTSD',
    'RnB',
    'RVA',
    'STL',
    'TV',
    'TX',
    'UFO',
    'UK',
    'UKG',
    'US',
    'USA',
    'USSR',
    'VGM',
    'VHS',
    'VTuber',
    'WWI',
    'WWII',
  ].map((word) => [word.toLowerCase(), word]),
)

/**
 * A tag name as the app shows it, whatever case its source used:
 * `Indie Rock`, `Based on Novel or Book`, `UK Garage`, `Lo-Fi`, `R&B`.
 * Every word starts with a capital except a minor word inside the name.
 * The stored name and the filter value keep their own spelling.
 */
export function formatTagName(name: string): string {
  const words = normalizeTagName(name).split(/([\s\-/&+.()[\]"“”:;,!?]+)/u)
  // Even entries are words, some of them empty beside a leading separator.
  const filled = words.flatMap((word, index) =>
    index % 2 === 0 && word ? [index] : [],
  )
  const first = filled.at(0)
  const last = filled.at(-1)
  return words
    .map((word, index) => {
      // Odd entries are the separators the split kept.
      if (index % 2 === 1 || !word) return word
      const fixed = TAG_FIXED_WORDS.get(word)
      if (fixed) return fixed
      // A minor word follows a space, hyphen or comma: `a` in `(a.i.)` does not.
      if (
        index !== first &&
        index !== last &&
        TAG_MINOR_WORDS.has(word) &&
        /^[\s\-,]+$/u.test(words[index - 1] ?? '')
      )
        return word
      const initial = word.charAt(0)
      const capital = initial.toUpperCase()
      // A letter such as ß has no single capital; leave the word as it is.
      return capital.length === 1 ? capital + word.slice(1) : word
    })
    .join('')
}

export const SourceNavigationLinkSchema = z.object({
  provider: z.string(),
  providerLabel: z.string(),
  name: z.string(),
  url: z
    .string()
    .url()
    .refine((value) => {
      try {
        const url = new URL(value)
        return (
          ['https:', 'http:'].includes(url.protocol) &&
          !url.username &&
          !url.password
        )
      } catch {
        return false
      }
    }),
})

const TagSourcesQuerySchema = z.object({
  name: z.string().min(1).max(1000),
  page: z.coerce.number().int().positive().default(1),
  size: z.coerce.number().int().positive().max(100).default(25),
})

export const TagProvenanceQuerySchema = TagSourcesQuerySchema.extend({
  mediaType: MediaTypeSchema.optional(),
  mediaId: z.string().min(1).max(200).optional(),
}).refine((query) => query.mediaType || query.mediaId, {
  message: 'Provide a media type or media item',
  path: ['mediaType'],
})

export const TagSourceSchema = z.object({
  provider: z.string().nullable(),
  source: z.string().nullable(),
  rawName: z.string(),
  sourceId: z.string().optional(),
  kind: z.string(),
})

export const TagReferenceSchema = z.object({
  id: z.string(),
  name: z.string(),
})

export const TagSchema = z.object({
  mediaType: MediaTypeSchema,
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  mediaCount: z.number().int().nonnegative(),
  hidden: z.boolean().default(false),
  mergedNames: z.array(z.string()).default([]),
  sources: z.array(TagSourceSchema),
  sourceCount: z.number().int().nonnegative(),
  parents: z.array(TagReferenceSchema).default([]),
  childCount: z.number().int().nonnegative().default(0),
})

export const TagSortKeySchema = z.enum([
  'name',
  'mediaCount',
  'sourceCount',
  'mergedNames',
])
export type TagSortKey = z.infer<typeof TagSortKeySchema>

export const TagListQuerySchema = z.object({
  sortBy: TagSortKeySchema.default('name'),
  direction: z.enum(['asc', 'desc']).default('asc'),
  mediaType: MediaTypeSchema.default('film'),
  q: z.string().max(200).optional(),
  visibility: z.enum(['visible', 'hidden', 'all']).default('visible'),
  // `unplaced` lists the tags outside the hierarchy: no parent and no subtags.
  placement: z.enum(['any', 'unplaced']).default('any'),
  page: z.coerce.number().int().positive().default(1),
  size: z.coerce.number().int().positive().max(100).default(25),
})

export const TagPageSchema = PaginatedDataSchema(TagSchema)
export const TagProvenanceSourceSchema = TagSourceSchema.extend({
  providerLabel: z.string().nullable(),
  onMedia: z.boolean().nullable(),
  link: SourceNavigationLinkSchema.nullable(),
  linkKind: z.enum(['tag', 'item', 'provider-item']).nullable(),
  itemTitle: z.string().optional(),
  linkNote: z.string().optional(),
  // The provider's latest job for the item this row describes.
  jobId: z.string().optional(),
})
export const TagProvenancePageSchema = PaginatedDataSchema(
  TagProvenanceSourceSchema,
).extend({ tagId: z.string().optional(), mediaType: MediaTypeSchema })
const TagOriginTypeSchema = MediaTypeSchema.or(z.literal('artist'))

export const ItemTagProvenanceQuerySchema = TagSourcesQuerySchema.extend({
  resourceType: z.enum(['album', 'film', 'track', 'artist']),
  resourceId: z.string().min(1).max(200),
})

export const TagReleaseSupportSchema = z
  .object({
    matchingReleases: z.number().int().positive(),
    taggedReleases: z.number().int().positive(),
  })
  .refine(
    ({ matchingReleases, taggedReleases }) =>
      matchingReleases <= taggedReleases,
    {
      path: ['matchingReleases'],
      message: 'Matching releases cannot exceed tagged releases',
    },
  )

export const ItemTagProvenanceSourceSchema = TagProvenanceSourceSchema.extend({
  originType: TagOriginTypeSchema,
  originId: z.string(),
  originTitle: z.string(),
  sourceLabel: z.string().optional(),
  snapshotId: z.string().optional(),
  releaseSupport: TagReleaseSupportSchema.optional(),
})

export const ItemTagProvenancePageSchema = PaginatedDataSchema(
  ItemTagProvenanceSourceSchema,
).extend({
  mediaType: MediaTypeSchema.optional(),
  tagId: z.string().optional(),
  originType: TagOriginTypeSchema,
  reason: z.enum(['direct', 'linked-album', 'artist-fallback']),
  linkedAlbum: z.object({ id: z.string(), title: z.string() }).optional(),
})

export type ItemTagProvenanceQuery = z.infer<
  typeof ItemTagProvenanceQuerySchema
>
export type ItemTagProvenancePage = z.infer<typeof ItemTagProvenancePageSchema>

export const TagParamsSchema = z.object({
  id: z.string().min(1).max(200),
})
export const TagDetailQuerySchema = z.object({
  mediaType: MediaTypeSchema,
  page: z.coerce.number().int().positive().default(1),
  size: z.coerce.number().int().positive().max(100).default(25),
})
export const TagDetailSchema = z.object({
  tag: TagSchema,
  aliases: z.array(
    z.object({ id: z.string(), name: z.string(), kind: z.string() }),
  ),
  // Direct subtags, hidden ones included.
  children: z.array(TagReferenceSchema).default([]),
  provenance: TagProvenancePageSchema,
})
export const SetTagVisibilitySchema = z.object({
  mediaType: MediaTypeSchema,
  tagIds: z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(100)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      'Select each tag only once',
    ),
  hidden: z.boolean(),
})
export const SetTagVisibilityResultSchema = z.object({
  updated: z.number().int().nonnegative(),
  hidden: z.boolean(),
})
const TagIdListSchema = z.array(z.string().min(1).max(200))

export const TagHierarchyQuerySchema = z.object({ mediaType: MediaTypeSchema })
export const TagHierarchyNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  hidden: z.boolean(),
  // Items carrying the tag itself.
  mediaCount: z.number().int().nonnegative(),
  // Items carrying the tag or any visible tag beneath it, each counted once.
  totalCount: z.number().int().nonnegative(),
  parentIds: z.array(z.string()),
})
export const TagHierarchySchema = z.object({
  mediaType: MediaTypeSchema,
  nodes: z.array(TagHierarchyNodeSchema),
  // Visible tags with no parent and no subtags.
  unplacedCount: z.number().int().nonnegative(),
})
export const SetTagParentsSchema = z
  .object({
    mediaType: MediaTypeSchema,
    tagIds: TagIdListSchema.min(1)
      .max(100)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        'Select each tag only once',
      ),
    parentIds: TagIdListSchema.max(20).refine(
      (ids) => new Set(ids).size === ids.length,
      'Select each parent only once',
    ),
    // replace: the listed parents become the only parents (none makes a top-level tag).
    mode: z.enum(['replace', 'add', 'remove']),
  })
  .superRefine((value, context) => {
    if (value.mode !== 'replace' && !value.parentIds.length)
      context.addIssue({
        code: 'custom',
        path: ['parentIds'],
        message: 'Choose a parent tag',
      })
    if (value.parentIds.some((id) => value.tagIds.includes(id)))
      context.addIssue({
        code: 'custom',
        path: ['parentIds'],
        message: 'A tag cannot be its own parent',
      })
  })
export const SetTagParentsResultSchema = z.object({
  updated: z.number().int().nonnegative(),
})
export const CreateTagSchema = z.object({
  mediaType: MediaTypeSchema,
  name: z
    .string()
    .max(200)
    .refine((name) => normalizeTagName(name) !== '', 'Enter a tag name'),
  parentIds: TagIdListSchema.max(20).default([]),
})
export const CreateTagResultSchema = z.object({
  id: z.string(),
  name: z.string(),
})
export type TagHierarchyQuery = z.infer<typeof TagHierarchyQuerySchema>
export type TagHierarchyNode = z.infer<typeof TagHierarchyNodeSchema>
export type TagHierarchy = z.infer<typeof TagHierarchySchema>
export type SetTagParentsInput = z.infer<typeof SetTagParentsSchema>
export type SetTagParentsResult = z.infer<typeof SetTagParentsResultSchema>
export type CreateTagInput = z.input<typeof CreateTagSchema>
export type CreateTagResult = z.infer<typeof CreateTagResultSchema>
export type TagDetailQuery = z.infer<typeof TagDetailQuerySchema>
export type TagDetail = z.infer<typeof TagDetailSchema>
export type SetTagVisibilityInput = z.infer<typeof SetTagVisibilitySchema>
export type SetTagVisibilityResult = z.infer<
  typeof SetTagVisibilityResultSchema
>
export type SourceNavigationLink = z.infer<typeof SourceNavigationLinkSchema>
export type TagProvenanceQuery = z.infer<typeof TagProvenanceQuerySchema>
export type TagProvenancePage = z.infer<typeof TagProvenancePageSchema>
export const MergeTagsSchema = z
  .object({
    mediaType: MediaTypeSchema,
    sourceIds: z.array(z.string().min(1)).min(1).max(100),
    targetId: z.string().min(1),
  })
  .superRefine((value, context) => {
    if (new Set(value.sourceIds).size !== value.sourceIds.length)
      context.addIssue({
        code: 'custom',
        path: ['sourceIds'],
        message: 'Select each source tag only once',
      })
    if (value.sourceIds.includes(value.targetId))
      context.addIssue({
        code: 'custom',
        path: ['targetId'],
        message: 'Target must not be a source tag',
      })
  })
export const MergeTagsResultSchema = z.object({
  merged: z.number().int().nonnegative(),
  targetId: z.string(),
})

export type Tag = z.infer<typeof TagSchema>
export type TagSummary = Tag
export type TagPage = z.infer<typeof TagPageSchema>
export type TagListQuery = z.infer<typeof TagListQuerySchema>
export type MergeTagsInput = z.infer<typeof MergeTagsSchema>
