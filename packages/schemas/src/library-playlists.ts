import { z } from 'zod'
import { BrowsePageSliceSchema, formatTagLevelsParam } from './browse'
import type { SavedView } from './imports'
import {
  AlbumListItemSchema,
  AlbumQuerySchema,
  FilmListItemSchema,
  FilmQuerySchema,
  type AlbumQuery,
  type FilmQuery,
} from './media'
import {
  SubscriptionItemQuerySchema,
  SubscriptionItemSchema,
  type SubscriptionItemQuery,
} from './subscriptions'
import {
  TrackListItemSchema,
  TrackQuerySchema,
  type TrackQuery,
} from './tracks'

/** The libraries that have playlists made in the app. Artists have none. */
export const LibraryPlaylistLibrarySchema = z.enum([
  'albums',
  'tracks',
  'films',
  'subscriptions',
  'mixes',
])
export type LibraryPlaylistLibrary = z.infer<
  typeof LibraryPlaylistLibrarySchema
>

/** A playlist holds entries; a smart playlist lists what its view matches. */
export const LibraryPlaylistTypeSchema = z.enum(['playlist', 'smart'])
export type LibraryPlaylistType = z.infer<typeof LibraryPlaylistTypeSchema>

/** The most items one selection can add. */
export const LIBRARY_PLAYLIST_SELECTION_MAX = 10_000
/** The most rows one list returns. */
export const LIBRARY_PLAYLIST_PAGE_MAX = 100

export const LibraryPlaylistIdSchema = z.string().min(1).max(100)
const ItemIdSchema = z.string().min(1).max(200)
export const LibraryPlaylistNameSchema = z.string().trim().min(1).max(200)

/** Browse URL parameters for layout and paging; never part of a view. */
export const browsePresentationParams: readonly string[] = [
  'view',
  'density',
  'columns',
  'columnOrder',
  'overlays',
  'page',
  'size',
]

const paging = new Set(['page', 'size'])
const queryParams = (shape: object, without: readonly string[] = []) =>
  Object.keys(shape).filter((key) => !paging.has(key) && !without.includes(key))
// The playlist's library decides a subscription view's library.
const subscriptionParams = queryParams(SubscriptionItemQuerySchema.shape, [
  'library',
])

/** The Browse URL parameters that decide a library's result and its order. */
export const libraryBrowseParams: Record<
  LibraryPlaylistLibrary,
  readonly string[]
> = {
  albums: queryParams(AlbumQuerySchema.shape),
  tracks: queryParams(TrackQuerySchema.shape),
  films: queryParams(FilmQuerySchema.shape),
  subscriptions: subscriptionParams,
  mixes: subscriptionParams,
}

/**
 * A saved view: Browse URL parameter names and their URL values, such as
 * `filters` as its JSON string. Validated against the library's Browse query.
 */
export const LibraryPlaylistViewSchema = z
  .record(z.string().min(1).max(64), z.string().max(20_000))
  .refine((view) => Object.keys(view).length <= 40, 'Too many parameters')
export type LibraryPlaylistView = z.infer<typeof LibraryPlaylistViewSchema>

/** A library's Browse query, parsed from a view. */
export type LibraryBrowseQuery =
  | { library: 'albums'; query: AlbumQuery }
  | { library: 'tracks'; query: TrackQuery }
  | { library: 'films'; query: FilmQuery }
  | { library: 'subscriptions' | 'mixes'; query: SubscriptionItemQuery }

export type LibraryBrowseViewResult =
  | { success: true; data: LibraryBrowseQuery }
  | { success: false; issues: string[] }

const zodIssues = (error: z.ZodError) =>
  error.issues.map((issue) =>
    issue.path.length
      ? `${issue.path.join('.')}: ${issue.message}`
      : issue.message,
  )

/**
 * Parses a view with the library's Browse query schema. Layout parameters
 * and parameters the library's Browse does not read are rejected.
 */
export function parseLibraryBrowseView(
  library: LibraryPlaylistLibrary,
  view: LibraryPlaylistView,
): LibraryBrowseViewResult {
  const unknown = Object.keys(view).flatMap((key) =>
    browsePresentationParams.includes(key)
      ? [`${key}: A layout setting is not part of a view`]
      : libraryBrowseParams[library].includes(key)
        ? []
        : [`${key}: Not a Browse parameter of this library`],
  )
  if (unknown.length) return { success: false, issues: unknown }
  switch (library) {
    case 'albums': {
      const parsed = AlbumQuerySchema.safeParse(view)
      return parsed.success
        ? { success: true, data: { library, query: parsed.data } }
        : { success: false, issues: zodIssues(parsed.error) }
    }
    case 'tracks': {
      const parsed = TrackQuerySchema.safeParse(view)
      return parsed.success
        ? { success: true, data: { library, query: parsed.data } }
        : { success: false, issues: zodIssues(parsed.error) }
    }
    case 'films': {
      const parsed = FilmQuerySchema.safeParse(view)
      return parsed.success
        ? { success: true, data: { library, query: parsed.data } }
        : { success: false, issues: zodIssues(parsed.error) }
    }
    case 'subscriptions':
    case 'mixes': {
      const parsed = SubscriptionItemQuerySchema.safeParse({
        ...view,
        library,
      })
      return parsed.success
        ? { success: true, data: { library, query: parsed.data } }
        : { success: false, issues: zodIssues(parsed.error) }
    }
  }
}

function addViewIssues(
  library: LibraryPlaylistLibrary,
  view: LibraryPlaylistView,
  context: z.RefinementCtx,
  path: (string | number)[],
) {
  const parsed = parseLibraryBrowseView(library, view)
  if (!parsed.success)
    for (const message of parsed.issues)
      context.addIssue({ code: 'custom', message, path })
}

/**
 * The Albums Browse parameters of a legacy saved view, as the Filters drawer
 * applied them: filters, ranges and listening as their URL JSON strings and
 * the limit as `limitResults`.
 */
export function savedViewParams(view: SavedView): LibraryPlaylistView {
  const tagLevels = formatTagLevelsParam(view.tagLevels)
  return {
    ...(view.filters.length ? { filters: JSON.stringify(view.filters) } : {}),
    ...(view.ranges.length ? { ranges: JSON.stringify(view.ranges) } : {}),
    ...(tagLevels ? { tagLevels } : {}),
    ...(view.listening ? { listening: JSON.stringify(view.listening) } : {}),
    ...(view.listeningSort
      ? { listeningSort: JSON.stringify(view.listeningSort) }
      : {}),
    sortBy: view.sortBy,
    direction: view.direction,
    ...(view.limit ? { limitResults: String(view.limit) } : {}),
  }
}

/**
 * Items to add: chosen IDs, or every match of a Browse query, resolved on the
 * server in Browse order, less `excludeIds`.
 */
export const LibraryPlaylistSelectionSchema = z.union([
  z
    .object({
      ids: z
        .array(ItemIdSchema)
        .min(1)
        .max(
          LIBRARY_PLAYLIST_SELECTION_MAX,
          `Select at most ${LIBRARY_PLAYLIST_SELECTION_MAX.toLocaleString('en-US')} items`,
        ),
    })
    .strict(),
  z
    .object({
      query: LibraryPlaylistViewSchema,
      excludeIds: z
        .array(ItemIdSchema)
        .max(LIBRARY_PLAYLIST_SELECTION_MAX)
        .default([]),
    })
    .strict(),
])
export type LibraryPlaylistSelection = z.infer<
  typeof LibraryPlaylistSelectionSchema
>

export const LibraryPlaylistParamsSchema = z.object({
  id: LibraryPlaylistIdSchema,
})
export const LibraryPlaylistBatchParamsSchema = z.object({
  id: LibraryPlaylistIdSchema,
  batchId: z.string().min(1).max(100),
})

/** PL-10: one library's playlists for pickers. */
export const LibraryPlaylistListQuerySchema = z.object({
  library: LibraryPlaylistLibrarySchema,
  type: LibraryPlaylistTypeSchema.optional(),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().positive().default(1),
  size: z.coerce
    .number()
    .int()
    .positive()
    .max(LIBRARY_PLAYLIST_PAGE_MAX)
    .default(25),
  /** Adds whether each playlist already holds this item. */
  itemId: ItemIdSchema.optional(),
})
export type LibraryPlaylistListQuery = z.infer<
  typeof LibraryPlaylistListQuerySchema
>

export const LibraryPlaylistSummarySchema = z.object({
  id: z.string(),
  library: LibraryPlaylistLibrarySchema,
  type: LibraryPlaylistTypeSchema,
  name: z.string(),
  /** Listed entries of a playlist; null for a smart playlist. */
  entryCount: z.number().int().nonnegative().nullable(),
  /** A smart playlist's view; null for a playlist. */
  view: LibraryPlaylistViewSchema.nullable(),
  updatedAt: z.string().datetime(),
  /** Whether it holds the requested item, when one was given. */
  containsItem: z.boolean().optional(),
})
export type LibraryPlaylistSummary = z.infer<
  typeof LibraryPlaylistSummarySchema
>

export const LibraryPlaylistPageSchema = BrowsePageSliceSchema(
  LibraryPlaylistSummarySchema,
)
export type LibraryPlaylistPage = z.infer<typeof LibraryPlaylistPageSchema>

/** PL-12: the playlist, its entry count and how many entries repeat an item. */
export const LibraryPlaylistDetailSchema = LibraryPlaylistSummarySchema.extend({
  createdAt: z.string().datetime(),
  /** Entries whose item is already earlier in the playlist. */
  repeatCount: z.number().int().nonnegative(),
})
export type LibraryPlaylistDetail = z.infer<typeof LibraryPlaylistDetailSchema>

/** PL-11: a playlist with optional items to add, or a smart playlist with its view. */
export const CreateLibraryPlaylistSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        type: z.literal('playlist'),
        library: LibraryPlaylistLibrarySchema,
        name: LibraryPlaylistNameSchema,
        selection: LibraryPlaylistSelectionSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('smart'),
        library: LibraryPlaylistLibrarySchema,
        name: LibraryPlaylistNameSchema,
        view: LibraryPlaylistViewSchema,
      })
      .strict(),
  ])
  .superRefine((input, context) => {
    if (input.type === 'smart')
      addViewIssues(input.library, input.view, context, ['view'])
    else if (input.selection && 'query' in input.selection)
      addViewIssues(input.library, input.selection.query, context, [
        'selection',
        'query',
      ])
  })
export type CreateLibraryPlaylist = z.infer<typeof CreateLibraryPlaylistSchema>

/** PL-11: rename, or replace a smart playlist's view. */
export const UpdateLibraryPlaylistSchema = z
  .object({
    name: LibraryPlaylistNameSchema.optional(),
    view: LibraryPlaylistViewSchema.optional(),
  })
  .strict()
  .refine(
    (input) => input.name !== undefined || input.view !== undefined,
    'Give a name or a view',
  )
export type UpdateLibraryPlaylist = z.infer<typeof UpdateLibraryPlaylistSchema>

export const LibraryPlaylistDuplicatesSchema = z.enum(['skip', 'again'])
export type LibraryPlaylistDuplicates = z.infer<
  typeof LibraryPlaylistDuplicatesSchema
>

/** PL-14: what a selection holds before it is added. */
export const LibraryPlaylistEntryCheckInputSchema = z
  .object({ selection: LibraryPlaylistSelectionSchema })
  .strict()
export type LibraryPlaylistEntryCheckInput = z.infer<
  typeof LibraryPlaylistEntryCheckInputSchema
>

export const LibraryPlaylistEntryCheckSchema = z.object({
  /** Items the selection holds. */
  total: z.number().int().nonnegative(),
  /** Of those, items already in the playlist. */
  present: z.number().int().nonnegative(),
  /** The first five present items in selection order. */
  sample: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        creator: z.string().nullable(),
      }),
    )
    .max(5),
})
export type LibraryPlaylistEntryCheck = z.infer<
  typeof LibraryPlaylistEntryCheckSchema
>

/** PL-14: appends a selection in selection order. */
export const LibraryPlaylistEntryAdditionInputSchema = z
  .object({
    selection: LibraryPlaylistSelectionSchema,
    duplicates: LibraryPlaylistDuplicatesSchema,
  })
  .strict()
export type LibraryPlaylistEntryAdditionInput = z.infer<
  typeof LibraryPlaylistEntryAdditionInputSchema
>

export const LibraryPlaylistEntryAdditionSchema = z.object({
  added: z.number().int().nonnegative(),
  /** Present items left out with `skip`. */
  skipped: z.number().int().nonnegative(),
  /** Present items added again with `again`. */
  repeated: z.number().int().nonnegative(),
  /** Undoes the addition. */
  batchId: z.string(),
})
export type LibraryPlaylistEntryAddition = z.infer<
  typeof LibraryPlaylistEntryAdditionSchema
>

export const LibraryPlaylistCreatedSchema = z.object({
  playlist: LibraryPlaylistDetailSchema,
  /** What the selection added; null without one. */
  addition: LibraryPlaylistEntryAdditionSchema.nullable(),
})
export type LibraryPlaylistCreated = z.infer<
  typeof LibraryPlaylistCreatedSchema
>

export const LibraryPlaylistAdditionUndoneSchema = z.object({
  removed: z.number().int().nonnegative(),
})

/** PL-15: entries by ID, or every entry whose item is earlier in the playlist. */
export const LibraryPlaylistEntryRemovalInputSchema = z.union([
  z
    .object({
      entryIds: z
        .array(z.string().min(1).max(100))
        .min(1)
        .max(LIBRARY_PLAYLIST_PAGE_MAX),
    })
    .strict(),
  z.object({ repeats: z.literal(true) }).strict(),
])
export type LibraryPlaylistEntryRemovalInput = z.infer<
  typeof LibraryPlaylistEntryRemovalInputSchema
>

export const LibraryPlaylistEntryRemovalSchema = z.object({
  removed: z.number().int().nonnegative(),
  /** Restores the removed entries in place. */
  batchId: z.string(),
})
export type LibraryPlaylistEntryRemoval = z.infer<
  typeof LibraryPlaylistEntryRemovalSchema
>

export const LibraryPlaylistEntryRestoreInputSchema = z
  .object({ batchId: z.string().min(1).max(100) })
  .strict()
export const LibraryPlaylistEntryRestoreSchema = z.object({
  restored: z.number().int().nonnegative(),
})

/** PL-12: a page of entries in position order. */
export const LibraryPlaylistEntriesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  size: z.coerce
    .number()
    .int()
    .positive()
    .max(LIBRARY_PLAYLIST_PAGE_MAX)
    .default(50),
})
export type LibraryPlaylistEntriesQuery = z.infer<
  typeof LibraryPlaylistEntriesQuerySchema
>

const entry = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    id: z.string(),
    /** One-based place among the listed entries. */
    position: z.number().int().positive(),
    addedAt: z.string().datetime(),
    /** The library's Browse row. */
    item,
  })
const entriesPage = <
  Library extends LibraryPlaylistLibrary,
  T extends z.ZodTypeAny,
>(
  library: Library,
  item: T,
) => BrowsePageSliceSchema(entry(item)).extend({ library: z.literal(library) })

export const LibraryPlaylistEntriesPageSchema = z.discriminatedUnion(
  'library',
  [
    entriesPage('albums', AlbumListItemSchema),
    entriesPage('tracks', TrackListItemSchema),
    entriesPage('films', FilmListItemSchema),
    entriesPage('subscriptions', SubscriptionItemSchema),
    entriesPage('mixes', SubscriptionItemSchema),
  ],
)
export type LibraryPlaylistEntriesPage = z.infer<
  typeof LibraryPlaylistEntriesPageSchema
>

/** PL-16: the playlists that hold an item. */
export const LibraryPlaylistMembershipsQuerySchema = z.object({
  library: LibraryPlaylistLibrarySchema,
  itemId: ItemIdSchema,
})
export type LibraryPlaylistMembershipsQuery = z.infer<
  typeof LibraryPlaylistMembershipsQuerySchema
>
export const LibraryPlaylistMembershipsSchema = z
  .array(LibraryPlaylistSummarySchema)
  .max(LIBRARY_PLAYLIST_PAGE_MAX)
