import { z } from 'zod'
import { JsonValueSchema, PaginatedDataSchema } from './common'

export const JobStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
])

export const JobScopeSchema = z.object({
  mediaItemIds: z.array(z.string()).default([]),
  mediaType: z.enum(['album', 'film']).nullable().default(null),
  limit: z.number().int().positive().max(100).default(5),
})

export const CreateJobSchema = z.object({
  provider: z.string().min(1),
  scope: JobScopeSchema.extend({
    mediaItemIds: z
      .array(z.string().min(1))
      .length(1, 'Select exactly one media item per job'),
    limit: z.number().int().min(1).max(1).default(1),
  }),
  options: z.record(z.string(), JsonValueSchema).default({}),
  confirmBroadRun: z.boolean().default(false),
})

export const JobListQuerySchema = z.object({
  mediaType: z.enum(['album', 'film']).optional(),
  status: z
    .union([JobStatusSchema, z.enum(['active', 'attention'])])
    .optional(),
  provider: z.string().optional(),
  mediaItemId: z.string().min(1).optional(),
  batchId: z.string().min(1).optional(),
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().positive().default(1),
  size: z.coerce.number().int().positive().max(100).default(25),
})

export const JobItemSchema = z.object({
  id: z.string(),
  mediaItemId: z.string().nullable(),
  mediaTitle: z.string().nullable().default(null),
  mediaType: z.enum(['album', 'film']).nullable().default(null),
  provider: z.string(),
  status: JobStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  message: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
})

export const JobErrorReviewSchema = z.object({
  reviewedAt: z.string(),
  userId: z.string().nullable(),
})
export const ReviewJobErrorSchema = z.object({ confirm: z.literal(true) })
export const DismissJobSchema = z.object({})
export const JobDismissalSchema = z.object({
  dismissedAt: z.string().datetime(),
  userId: z.string().nullable(),
})

export function getJobDismissal(options: Record<string, unknown>) {
  const result = JobDismissalSchema.safeParse(options.dismissal)
  return result.success ? result.data : null
}

export const JobLogSchema = z.object({
  id: z.string(),
  level: z.enum(['info', 'warn', 'error']),
  message: z.string(),
  metadata: JsonValueSchema.nullable(),
  createdAt: z.string(),
  canMarkBenign: z.boolean().default(false),
  benignReview: JobErrorReviewSchema.nullable().default(null),
})

const ErrorEntrySchema = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().nullable(),
})

export const JobErrorDetailsSchema = ErrorEntrySchema.extend({
  causes: z.array(ErrorEntrySchema),
})
export type JobErrorDetails = z.infer<typeof JobErrorDetailsSchema>

export const JobSchema = z.object({
  id: z.string(),
  provider: z.string(),
  status: JobStatusSchema,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  errorMessage: z.string().nullable(),
  scope: JobScopeSchema,
  options: z.record(z.string(), JsonValueSchema),
  confirmBroadRun: z.boolean(),
  items: z.array(JobItemSchema),
  logs: z.array(JobLogSchema),
})

export type CreateJobInput = z.infer<typeof CreateJobSchema>
export type Job = z.infer<typeof JobSchema>
export const JobPageSchema = PaginatedDataSchema(JobSchema)
export type JobPage = z.infer<typeof JobPageSchema>

export const JobDataSchema = z.object({
  jobId: z.string(),
  snapshots: z.array(
    z.object({
      id: z.string(),
      mediaItemId: z.string().nullable(),
      provider: z.string(),
      createdAt: z.string(),
      payload: JsonValueSchema,
    }),
  ),
  diagnostics: z.array(
    z.object({
      id: z.string(),
      createdAt: z.string(),
      data: JsonValueSchema,
    }),
  ),
  itemPayloads: z.array(
    z.object({
      id: z.string(),
      mediaItemId: z.string().nullable(),
      provider: z.string(),
      payload: JsonValueSchema,
    }),
  ),
})
export type JobData = z.infer<typeof JobDataSchema>

export const JobActivitySchema = z.object({
  queued: z.number(),
  running: z.number(),
  failed: z.number(),
  imports: z.number(),
  completed: z.number(),
  completedImports: z.number(),
  libraries: z
    .array(
      z.object({
        mediaType: z.enum(['album', 'film']),
        queued: z.number(),
        running: z.number(),
        failed: z.number(),
        imports: z.number(),
      }),
    )
    .default([]),
})
export const EnrichmentResultSchema = z.object({
  batchId: z.string(),
  queued: z.number(),
  skipped: z.number(),
  warnings: z.array(z.string()),
})
export const RefreshFilmsSchema = z.object({
  providers: z.array(z.string().min(1)).min(1).max(20),
  olderThanDays: z.number().int().min(1).max(3650).default(180),
  limit: z.number().int().min(1).max(100).default(5),
})
export const RefreshPreviewSchema = z.object({
  total: z.number(),
  jobs: z.number(),
  items: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      providers: z.array(
        z.object({
          provider: z.string(),
          lastScrapedAt: z.string().nullable(),
        }),
      ),
    }),
  ),
})
export const StartRefreshSchema = RefreshFilmsSchema.extend({
  mediaItemIds: z.array(z.string().min(1)).min(1).max(100),
  confirmBroadRun: z.boolean().default(false),
})
export const RetryJobsSchema = z.object({
  confirmBroadRun: z.boolean().default(false),
})

const BulkJobIdsSchema = z
  .array(z.string().min(1))
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'Job IDs must be unique',
  })

export const BulkRetryJobsSchema = RetryJobsSchema.extend({
  jobIds: BulkJobIdsSchema,
  confirmRunning: z.boolean().optional(),
})

export const BulkCancelJobsSchema = z.object({
  jobIds: BulkJobIdsSchema,
  confirmRunning: z.boolean().default(false),
})
export const BulkCancelJobsResultSchema = z.object({
  cancelled: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  results: z.array(
    z.object({
      jobId: z.string(),
      status: z.enum(['cancelled', 'skipped', 'failed']),
      message: z.string().optional(),
    }),
  ),
})
export type BulkCancelJobsInput = z.infer<typeof BulkCancelJobsSchema>
export type BulkCancelJobsResult = z.infer<typeof BulkCancelJobsResultSchema>

export function isRetryableJobStatus(status: Job['status']): boolean {
  return status === 'failed' || status === 'cancelled' || status === 'running'
}

export function isUnfinishedJobItem(
  status: Job['status'],
  jobStatus: Job['status'],
): boolean {
  return (
    status === 'failed' ||
    status === 'cancelled' ||
    (jobStatus === 'running' && (status === 'queued' || status === 'running'))
  )
}

export const BulkRetryJobsResultSchema = z.object({
  queued: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  results: z.array(
    z.object({
      jobId: z.string(),
      status: z.enum(['queued', 'skipped', 'failed']),
      retryJobId: z.string().optional(),
      message: z.string().optional(),
    }),
  ),
})
export type BulkRetryJobsInput = z.infer<typeof BulkRetryJobsSchema>
export type BulkRetryJobsResult = z.infer<typeof BulkRetryJobsResultSchema>

export const BulkDismissJobsSchema = z.object({ jobIds: BulkJobIdsSchema })
export const BulkDismissJobsResultSchema = z.object({
  dismissed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  results: z.array(
    z.object({
      jobId: z.string(),
      status: z.enum(['dismissed', 'skipped', 'failed']),
      message: z.string().optional(),
    }),
  ),
})
export type BulkDismissJobsInput = z.infer<typeof BulkDismissJobsSchema>
export type BulkDismissJobsResult = z.infer<typeof BulkDismissJobsResultSchema>

export function shouldPollJobList(jobs: Job[]): boolean {
  return jobs.some((job) => job.status === 'queued' || job.status === 'running')
}
