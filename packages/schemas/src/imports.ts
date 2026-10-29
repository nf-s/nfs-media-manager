import { z } from 'zod'
import { JsonValueSchema } from './common'
import { removeSpotifyAudioFeatures } from './audio-features'
import {
  BrowseFilterSchema,
  BrowseKeySchema,
  BrowseRangeSchema,
} from './browse'

export const StartImportSchema = z.object({
  fullLibrary: z.boolean().default(false),
  albumLimit: z.number().int().min(0).max(5).default(2),
  filmLimit: z.number().int().min(0).max(5).default(2),
})
export const ImportStatusQuerySchema = z.object({
  mediaType: z.enum(['album', 'film']).optional(),
})
export const ImportRunSchema = z.object({
  id: z.string(),
  mediaType: z.enum(['album', 'film']).nullable().default(null),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  stage: z.string(),
  processed: z.number(),
  total: z.number(),
  errorMessage: z.string().nullable(),
  result: z
    .object({
      albums: z.number(),
      films: z.number(),
      mediaType: z.enum(['album', 'film']).nullable().optional(),
      created: z.number().optional(),
      updated: z.number().optional(),
      unchanged: z.number().optional(),
      skipped: z.number().optional(),
      failed: z.number().optional(),
      warnings: z.array(z.string()).optional(),
      jobBatchId: z.string().optional(),
      queuedJobs: z.number().optional(),
      skippedJobs: z.number().optional(),
    })
    .nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
})
export const ImportStatusSchema = z.object({
  sources: z.array(
    z.object({
      name: z.string(),
      available: z.boolean(),
      bytes: z.number().nullable(),
      updatedAt: z.string().nullable(),
    }),
  ),
  runs: z.array(ImportRunSchema),
})
export const SavedViewSchema = z.object({
  name: z.string(),
  filters: z.array(BrowseFilterSchema),
  ranges: z.array(BrowseRangeSchema),
  sortBy: BrowseKeySchema,
  direction: z.enum(['asc', 'desc']),
  limit: z.number().int().positive().optional(),
})
export type ImportRun = z.infer<typeof ImportRunSchema>
export type SavedView = z.infer<typeof SavedViewSchema>

export const FileImportSchema = z.object({
  format: z.string().min(1),
  path: z.string().trim().min(1).max(4096),
  limit: z.number().int().min(1).max(5).default(3),
  fullImport: z.boolean().default(false),
})
export const FileImportFormatSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['csv', 'nfo']),
})
export const FileImportPreviewSchema = z.object({
  samples: z.array(
    z.object({
      title: z.string(),
      identifiers: z.array(z.string()),
      source: z.string(),
    }),
  ),
  selected: z.number(),
  skipped: z.number(),
  warnings: z.array(z.string()),
})

export const FilmPreviewInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('csv'),
      format: z.string().min(1),
      fileName: z
        .string()
        .max(255)
        .regex(/\.csv$/i),
      content: z
        .string()
        .min(1)
        .max(20 * 1024 * 1024),
    })
    .strict(),
  z.object({ kind: z.literal('nfo') }).strict(),
])
export const FilmImportPreviewSchema = z.object({
  id: z.string(),
  kind: z.enum(['csv', 'nfo']),
  source: z.string(),
  expiresAt: z.string(),
  existing: z.number(),
  skipped: z.number(),
  warnings: z.array(z.string()),
  items: z.array(
    z.object({
      row: z.number().int(),
      title: z.string(),
      identifiers: z.array(z.string()),
      action: z.enum(['new', 'update', 'unchanged']),
      changes: z
        .array(
          z.object({
            field: z.string(),
            label: z.string(),
            before: JsonValueSchema,
            after: JsonValueSchema,
          }),
        )
        .default([]),
      needsIdentification: z.boolean(),
    }),
  ),
})
export const ConfirmFilmImportSchema = z.object({
  previewId: z.string().min(1),
  rows: z.array(z.number().int().min(0).max(9999)).min(1).max(10000),
  providers: z.array(z.string().min(1)).max(20).default([]),
  confirmBroadRun: z.boolean().default(false),
})
export const NfoSourceSchema = z.object({
  path: z.string().nullable(),
  available: z.boolean(),
})
export type FilmImportPreview = z.infer<typeof FilmImportPreviewSchema>

export const LegacySavedViewSchema = z.object({
  name: z.string(),
  filters: z
    .array(
      z.object({
        field: z.string(),
        value: z.string().optional(),
        min: z.number().optional(),
        max: z.number().optional(),
        includeUndefined: z.boolean().optional(),
        exclude: z.boolean().optional(),
        intersection: z.boolean().optional(),
      }),
    )
    .default([]),
  sort: z
    .tuple([z.string(), z.enum(['ASC', 'DESC'])])
    .default(['dateAdded', 'DESC']),
  limit: z.number().int().min(1).max(10000).optional(),
})

export function normalizeSavedView(input: unknown): SavedView {
  const value = LegacySavedViewSchema.parse(
    removeSpotifyAudioFeatures(input).value,
  )
  const aliases: Record<string, string> = {
    genres: 'genre',
    artists: 'artist',
    countries: 'country',
    playlists: 'playlist',
    dateReleased: 'releaseDate',
  }
  const key = (field: string) => aliases[field] ?? field
  const filters = value.filters.flatMap((filter) =>
    filter.value === undefined
      ? []
      : [
          {
            field: key(filter.field),
            value: filter.value,
            mode: filter.exclude
              ? 'exclude'
              : filter.intersection
                ? 'required'
                : 'any',
          },
        ],
  )
  return SavedViewSchema.parse({
    name: value.name,
    sortBy: key(value.sort[0]),
    direction: value.sort[1].toLowerCase(),
    limit: value.limit,
    filters: filters.filter(
      (filter, index) =>
        filters.findIndex(
          (other) =>
            other.field === filter.field &&
            other.value === filter.value &&
            other.mode === filter.mode,
        ) === index,
    ),
    ranges: value.filters
      .filter((filter) => filter.value === undefined)
      .map((filter) => ({
        field: key(filter.field),
        min: filter.min,
        max: filter.max,
        includeMissing: filter.includeUndefined ?? false,
      })),
  })
}
