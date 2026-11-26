import { z } from 'zod'
import { CatalogScopeQuerySchema } from './catalog'
import { JsonValueSchema, PaginatedDataSchema } from './common'
import {
  ProviderRequestDiagnosticsSchema,
  ProviderWaitingSchema,
} from './provider'

export const JobStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
])

export const CloudDispatchJobIdsSchema = z
  .array(z.string().min(1).max(200))
  .max(10)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'Job IDs must be unique',
  })
  .nullable()

export const CloudDispatchControlSchema = z
  .object({
    paused: z.boolean(),
    jobIds: CloudDispatchJobIdsSchema.optional(),
  })
  .strict()

export const CloudDispatchStatusSchema = z.object({
  provider: z.string().min(1).max(200),
  paused: z.boolean(),
  allowedJobIds: CloudDispatchJobIdsSchema.default(null),
  stopped: z.boolean(),
  failures: z.number().int().nonnegative(),
  infrastructureFailures: z.number().int().nonnegative(),
  slots: z
    .array(
      z.object({
        jobId: z.string().min(1).max(200),
        phase: z.enum(['offered', 'running']),
        expiresAt: z.number().int().nonnegative(),
      }),
    )
    .max(32),
})
export type CloudDispatchStatus = z.infer<typeof CloudDispatchStatusSchema>

export const JobScopeSchema = z.object({
  mediaItemIds: z.array(z.string()).default([]),
  mediaType: z.enum(['album', 'film', 'track']).nullable().default(null),
  limit: z.number().int().positive().max(100).default(5),
})

export const CreateJobSchema = z.object({
  provider: z.string().min(1),
  scope: JobScopeSchema.extend({
    mediaType: z.enum(['album', 'film']).nullable().default(null),
    mediaItemIds: z
      .array(z.string().min(1))
      .length(1, 'Select exactly one media item per job'),
    limit: z.number().int().min(1).max(1).default(1),
  }),
  options: z.record(z.string(), JsonValueSchema).default({}),
  confirmBroadRun: z.boolean().default(false),
})

export const JobSortKeySchema = z.enum([
  'provider',
  'title',
  'status',
  'createdAt',
  'startedAt',
  'finishedAt',
  'result',
])
export type JobSortKey = z.infer<typeof JobSortKeySchema>

export const JobStatusFilterSchema = z.union([
  JobStatusSchema,
  z.enum(['active', 'attention']),
])
export type JobStatusFilter = z.infer<typeof JobStatusFilterSchema>

export const jobStatusFilters: { value: JobStatusFilter; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'attention', label: 'Needs attention' },
  { value: 'queued', label: 'Queued' },
  { value: 'running', label: 'Running' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
]

function parseFilterValues(value: unknown) {
  if (value === undefined) return []
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export const JobLibrarySchema = z.enum([
  'album',
  'film',
  'track',
  'artist',
  'subscription',
  'mix',
])

export const JobListQuerySchema = z.object({
  sortBy: JobSortKeySchema.default('createdAt'),
  direction: z.enum(['asc', 'desc']).default('desc'),
  mediaType: JobLibrarySchema.optional(),
  status: JobStatusFilterSchema.optional(),
  statuses: z
    .preprocess(parseFilterValues, z.array(JobStatusFilterSchema).max(7))
    .default([]),
  providers: z
    .preprocess(parseFilterValues, z.array(z.string().min(1)).max(100))
    .default([]),
  provider: z.string().optional(),
  mediaItemId: z.string().min(1).optional(),
  artistId: z.string().min(1).max(200).optional(),
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

/** Task jobs carry a task name and no media item. */
export function getJobTask(options: Record<string, unknown>) {
  return typeof options.task === 'string' ? options.task : null
}

/**
 * How far a task job has read, kept in `options.progress` and updated after
 * every page while it runs. `totalPages` is null until the total is known.
 */
export const JobProgressSchema = z.object({
  pagesRead: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative().nullable(),
})
export type JobProgress = z.infer<typeof JobProgressSchema>

export function getJobProgress(
  options: Record<string, unknown>,
): JobProgress | null {
  const result = JobProgressSchema.safeParse(options.progress)
  return result.success ? result.data : null
}

/** The latest recorded stage of a job, stored in `options.activity`. */
export const JobActivityStageSchema = z.object({
  stage: z.string().trim().min(1),
  done: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
  unit: z.string().trim().min(1).optional(),
  startedAt: z.string().datetime(),
})
export type JobActivityStage = z.infer<typeof JobActivityStageSchema>

export function getJobActivityStage(
  options: Record<string, unknown>,
): JobActivityStage | null {
  const result = JobActivityStageSchema.safeParse(options.activity)
  return result.success ? result.data : null
}

/** Stage transitions retain the preceding stage's progress and duration. */
export const JobActivityLogMetadataSchema = z.object({
  activity: JobActivityStageSchema.optional(),
  previousActivity: JobActivityStageSchema.extend({
    durationMs: z.number().int().nonnegative(),
  }).optional(),
})

export const JobLogSchema = z.object({
  id: z.string(),
  level: z.enum(['info', 'warn', 'error']),
  message: z.string(),
  metadata: JsonValueSchema.nullable(),
  createdAt: z.string(),
  canMarkBenign: z.boolean().default(false),
  benignReview: JobErrorReviewSchema.nullable().default(null),
})

export const JobErrorCodeSchema = z.enum([
  'rate-limit',
  'cooldown',
  'request-failed',
  'access-denied',
])
export type JobErrorCode = z.infer<typeof JobErrorCodeSchema>

const ErrorEntrySchema = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().nullable(),
  code: JobErrorCodeSchema.optional(),
  retryAt: z
    .number()
    .int()
    .nonnegative()
    .max(8640000000000000)
    .nullable()
    .optional(),
  diagnostics: ProviderRequestDiagnosticsSchema.optional(),
})

export const JobErrorDetailsSchema = ErrorEntrySchema.extend({
  causes: z.array(ErrorEntrySchema),
})
export type JobErrorDetails = z.infer<typeof JobErrorDetailsSchema>

/** Progress of a task job: pages read and, once known, the total. */
export const JobProgressCountSchema = z.object({
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().nullable(),
})
export type JobProgressCount = z.infer<typeof JobProgressCountSchema>

export function getJobProgressCount(
  options: Record<string, unknown>,
): JobProgressCount | null {
  const progress = getJobProgress(options)
  return progress
    ? { done: progress.pagesRead, total: progress.totalPages }
    : null
}

/**
 * Next steps a job's summary can offer:
 * - `retry`: queue a replacement for the unfinished work.
 * - `find-match`: choose the item's identity at this provider.
 * - `open-provider`: open the provider page.
 * - `resume-provider`: resume a paused or stopped queue, or clear a cooldown.
 * - `sign-in`: sign in to the provider's account again.
 * - `add-key`: add or replace the provider's credentials.
 */
export const JobSummaryActionSchema = z.enum([
  'retry',
  'find-match',
  'open-provider',
  'resume-provider',
  'sign-in',
  'add-key',
])
export type JobSummaryAction = z.infer<typeof JobSummaryActionSchema>

export const JobSummarySchema = z.object({
  headline: z.string(),
  code: JobErrorCodeSchema.nullable(),
  retryAt: z.string().datetime().nullable(),
  actions: z.array(JobSummaryActionSchema),
})
export type JobSummary = z.infer<typeof JobSummarySchema>

/** The library item a task job is about, read when the job is loaded. */
export const JobSubjectSchema = z.object({
  title: z.string(),
  /** Its credited artists, joined; null when it has none. */
  artists: z.string().nullable(),
})
export type JobSubject = z.infer<typeof JobSubjectSchema>

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
  /** Why a queued job has not started; null for other statuses. */
  waiting: ProviderWaitingSchema.nullable().optional(),
  progress: JobProgressCountSchema.nullable().optional(),
  /** Set for task jobs whose options name a library item that still exists. */
  subject: JobSubjectSchema.nullable().optional(),
  /** Returned by job detail only. */
  summary: JobSummarySchema.nullable().optional(),
})

export type CreateJobInput = z.infer<typeof CreateJobSchema>
export type Job = z.infer<typeof JobSchema>
export const JobPageSchema = PaginatedDataSchema(JobSchema)
export type JobPage = z.infer<typeof JobPageSchema>

export const JobBatchEntrySchema = z.object({
  kind: z.literal('batch'),
  batchId: z.string(),
  /** The only provider in the batch, or null when it has several. */
  provider: z.string().nullable(),
  providers: z.array(z.string()),
  mediaType: JobLibrarySchema.nullable(),
  /** Where the batch came from when known, such as a library import. */
  label: z.string().nullable(),
  /**
   * The task every job in the batch runs; null when they are all item
   * scrapes; absent when they differ.
   */
  task: z.string().nullable().optional(),
  importId: z.string().nullable(),
  /** Counts cover every job in the batch, not only those matching filters. */
  total: z.number().int().nonnegative(),
  /** Jobs in the batch that match the list filters. */
  matching: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  /** Earliest start. */
  startedAt: z.string().datetime().nullable(),
  /** Latest finish once every job has finished. */
  finishedAt: z.string().datetime().nullable(),
  /** Set while nothing in the batch is running and work remains queued. */
  waiting: ProviderWaitingSchema.nullable(),
})
export const JobEntrySchema = z.discriminatedUnion('kind', [
  JobBatchEntrySchema,
  z.object({ kind: z.literal('job'), job: JobSchema }),
])
export const JobEntryPageSchema = PaginatedDataSchema(JobEntrySchema)
export type JobBatchEntry = z.infer<typeof JobBatchEntrySchema>
export type JobEntry = z.infer<typeof JobEntrySchema>
export type JobEntryPage = z.infer<typeof JobEntryPageSchema>

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
        mediaType: JobLibrarySchema,
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
  ...CatalogScopeQuerySchema.shape,
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
export const RetryJobBatchSchema = RetryJobsSchema.extend({
  batchId: z.string().uuid().optional(),
})

const BulkJobIdsSchema = z
  .array(z.string().min(1))
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'Job IDs must be unique',
  })

export const BulkRetryJobsSchema = RetryJobBatchSchema.extend({
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
/** Cancel every queued job in a batch, and its running jobs when confirmed. */
export const CancelJobBatchSchema = z.object({
  confirmRunning: z.boolean().default(false),
})
export type CancelJobBatchInput = z.infer<typeof CancelJobBatchSchema>

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
