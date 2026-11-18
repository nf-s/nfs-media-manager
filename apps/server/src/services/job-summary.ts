import { z } from 'zod'
import {
  JobErrorDetailsSchema,
  getJobTask,
  isRetryableJobStatus,
  type Job,
  type JobErrorCode,
  type JobSummary,
  type JobSummaryAction,
} from '@repo/schemas/job'
import type { ProviderWaiting } from '@repo/schemas/provider'
import { SPOTIFY_TRACK_SEARCH_TASK } from '@repo/schemas/spotify-track-search'
import {
  jobWaiting,
  loadProviderWaitStates,
  type ProviderWaitState,
} from '@/services/job-waiting'
import { hasAccountSignIn } from '@/services/provider-connections'

const ErrorLogMetadataSchema = z.object({
  error: JobErrorDetailsSchema,
  classification: z.enum(['not-found', 'ambiguous']).optional(),
})

const resumableReasons = new Set<ProviderWaiting['reason']>([
  'cooldown',
  'paused',
  'stopped',
])

function latestErrorLog(job: Job) {
  for (const log of [...job.logs].reverse()) {
    if (log.level !== 'error') continue
    const parsed = ErrorLogMetadataSchema.safeParse(log.metadata)
    if (parsed.success) return { message: log.message, ...parsed.data }
  }
  return null
}

function latestLogMessage(job: Job, levels: Job['logs'][number]['level'][]) {
  return (
    [...job.logs].reverse().find((log) => levels.includes(log.level))
      ?.message ?? null
  )
}

function credentialAction(job: Job): JobSummaryAction {
  // Account tasks use the signed-in account; item scrapes use stored keys.
  if (getJobTask(job.options) === SPOTIFY_TRACK_SEARCH_TASK) return 'add-key'
  return hasAccountSignIn(job.provider) && getJobTask(job.options) !== null
    ? 'sign-in'
    : 'add-key'
}

function waitingActions(
  job: Job,
  waiting: ProviderWaiting,
): JobSummaryAction[] {
  if (waiting.reason === 'access-denied') return [credentialAction(job)]
  if (resumableReasons.has(waiting.reason)) return ['resume-provider']
  if (
    waiting.reason === 'worker-offline' ||
    waiting.reason === 'not-configured' ||
    waiting.reason === 'budget' ||
    waiting.reason === 'rate-limit'
  )
    return ['open-provider']
  return []
}

const codeHeadlines: Partial<Record<JobErrorCode, string>> = {
  'rate-limit': 'The provider rate limited this request',
  cooldown: 'The provider was cooling down',
  'access-denied': 'The provider denied access',
}

/**
 * Leads a job's details: what happened and the actions that address it,
 * derived only from the stored error and the provider's current state.
 */
export function summarizeJob(
  job: Job,
  state: ProviderWaitState | null,
): JobSummary {
  if (job.status === 'queued') {
    const waiting = state ? jobWaiting(state, job.id) : null
    return {
      headline: waiting?.detail ?? 'Queued',
      code: null,
      retryAt: waiting?.until ?? null,
      actions: waiting ? waitingActions(job, waiting) : [],
    }
  }
  if (job.status === 'running')
    return { headline: 'Running', code: null, retryAt: null, actions: [] }
  if (job.status === 'succeeded')
    return {
      headline: latestLogMessage(job, ['info']) ?? 'Succeeded',
      code: null,
      retryAt: null,
      actions: [],
    }
  const failure = latestErrorLog(job)
  const code =
    failure?.error.code ??
    failure?.error.causes.find((cause) => cause.code)?.code ??
    null
  const retryAtMs =
    failure?.error.retryAt ??
    failure?.error.causes.find((cause) => cause.retryAt)?.retryAt ??
    null
  const block = state?.block ?? null
  const cooling =
    (code === 'rate-limit' || code === 'cooldown') &&
    state?.cooldownUntil !== null &&
    state?.cooldownUntil !== undefined &&
    state.cooldownUntil > state.now
      ? state.cooldownUntil
      : null
  const retryAt =
    retryAtMs !== null && retryAtMs > 0
      ? new Date(retryAtMs).toISOString()
      : cooling !== null
        ? new Date(cooling).toISOString()
        : null
  const replaced = typeof job.options.retryJobId === 'string'
  const retry: JobSummaryAction[] =
    !replaced && isRetryableJobStatus(job.status) ? ['retry'] : []
  const stored =
    job.errorMessage ??
    failure?.message ??
    latestLogMessage(job, ['error', 'warn']) ??
    (job.status === 'failed' ? 'Failed' : 'Cancelled')
  const canFindMatch =
    job.items.some((item) => item.mediaItemId !== null) ||
    typeof job.options.artistId === 'string'
  const findMatch: JobSummaryAction[] = canFindMatch ? ['find-match'] : []
  if (failure?.classification && job.status === 'failed')
    return {
      headline:
        failure.classification === 'not-found'
          ? 'No matching item at the provider'
          : 'Several possible matches at the provider',
      code,
      retryAt,
      actions: [...findMatch, ...retry],
    }
  if (job.status === 'failed' && code !== null) {
    const actions: JobSummaryAction[] =
      code === 'access-denied'
        ? [credentialAction(job), ...(state?.halted ? [] : retry)]
        : code === 'request-failed'
          ? [...retry, 'open-provider']
          : block && resumableReasons.has(block.reason)
            ? ['resume-provider', 'open-provider']
            : [...retry, 'open-provider']
    return {
      headline: codeHeadlines[code] ?? stored,
      code,
      retryAt,
      actions,
    }
  }
  return { headline: stored, code, retryAt, actions: retry }
}

/** A job's details with why it waits and the summary it leads with. */
export async function describeJob(job: Job): Promise<Job> {
  const state =
    (await loadProviderWaitStates([job.provider])).get(job.provider) ?? null
  return {
    ...job,
    waiting:
      job.status === 'queued' && state ? jobWaiting(state, job.id) : null,
    summary: summarizeJob(job, state),
  }
}
