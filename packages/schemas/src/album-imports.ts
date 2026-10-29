import { z } from 'zod'

export const AlbumCsvPreviewInputSchema = z
  .object({
    format: z.enum(['album-csv', 'upc-csv']),
    fileName: z
      .string()
      .min(1)
      .max(255)
      .regex(/\.csv$/i),
    content: z
      .string()
      .min(1)
      .max(20 * 1024 * 1024),
  })
  .strict()

export const AlbumImportPreviewSchema = z.object({
  id: z.string(),
  kind: z.enum(['csv', 'spotify']),
  source: z.string(),
  expiresAt: z.string().datetime(),
  existing: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  items: z.array(
    z.object({
      row: z.number().int().nonnegative(),
      title: z.string(),
      dateAdded: z.string().datetime({ offset: true }).nullable().optional(),
      artists: z.array(z.string()),
      identifiers: z.array(z.string()),
      action: z.enum(['new', 'unchanged']),
      needsIdentification: z.boolean(),
    }),
  ),
  discovery: z
    .object({
      offset: z.number().int().nonnegative(),
      requested: z.number().int().positive(),
      received: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      nextOffset: z.number().int().nonnegative().nullable(),
      scanned: z.number().int().nonnegative().optional(),
      complete: z.boolean().optional(),
      order: z.literal('dateAddedDesc').optional(),
    })
    .optional(),
})

export const ConfirmAlbumImportSchema = z
  .object({
    previewId: z.string().min(1),
    rows: z.array(z.number().int().min(0).max(9999)).min(1).max(10000),
    providers: z.array(z.string().min(1)).max(20).default([]),
    confirmBroadRun: z.boolean().default(false),
  })
  .strict()

export type AlbumImportPreview = z.infer<typeof AlbumImportPreviewSchema>
