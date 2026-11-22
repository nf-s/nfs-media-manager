import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { JsonValueSchema } from '@repo/schemas/common'
import type { ProviderResponseCapture } from '@repo/schemas/provider-response'
import {
  isProviderReplayTask,
  stationForProviderTask,
} from '@/lib/provider-task-scope'
import { db } from '@/lib/db'
import {
  createProviderResponseReplay,
  ProviderResponseStorageError,
} from '@/lib/provider-response-history'
import { scrapeJob } from '@/schemas/db'
import { mixStationCapturePolicy } from '@/lib/mix-station-archive'
import { replayMixStationSteps } from './mix-station-replay'
import { replayProviderSearchTask } from './provider-search-task-replay'
import { replayTidalTrackMatch } from './tidal-track-lookup'

const stepSchema = z
  .object({
    operation: z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,59}$/),
    args: JsonValueSchema,
  })
  .strict()
const maxSteps = 1000
export const ProviderTaskReplayStepsSchema = z
  .array(stepSchema)
  .min(1)
  .max(maxSteps)
export type ProviderTaskReplayStep = z.infer<typeof stepSchema>

export async function appendProviderTaskReplayStep(
  jobId: string,
  provider: string,
  task: string,
  step: ProviderTaskReplayStep,
) {
  try {
    const encoded = JSON.stringify(stepSchema.parse(step))
    if (
      Buffer.byteLength(encoded) > 8192 ||
      !isProviderReplayTask(task, provider)
    )
      throw new ProviderResponseStorageError()
    const [updated] = await db
      .update(scrapeJob)
      .set({
        options: sql`jsonb_set(${scrapeJob.options}, '{providerReplaySteps}', coalesce(${scrapeJob.options}->'providerReplaySteps', '[]'::jsonb) || jsonb_build_array(${encoded}::jsonb))`,
      })
      .where(
        and(
          eq(scrapeJob.id, jobId),
          eq(scrapeJob.provider, provider),
          eq(scrapeJob.status, 'running'),
          sql`${scrapeJob.options}->>'task' = ${task}`,
          sql`jsonb_array_length(coalesce(${scrapeJob.options}->'providerReplaySteps', '[]'::jsonb)) < ${maxSteps}`,
        ),
      )
      .returning({ id: scrapeJob.id })
    if (!updated) throw new ProviderResponseStorageError()
  } catch {
    throw new ProviderResponseStorageError()
  }
}

export async function replayProviderTask(
  task: string,
  provider: string,
  steps: readonly ProviderTaskReplayStep[],
  captures: readonly ProviderResponseCapture[],
) {
  if (!isProviderReplayTask(task, provider))
    throw new Error('Unsupported provider replay task')
  const station = stationForProviderTask(task, provider)
  const replay = createProviderResponseReplay(captures, {
    capturePolicy: station ? mixStationCapturePolicy(station) : undefined,
  })
  const request = replay.requestFor('task')
  try {
    return station
      ? await replayMixStationSteps(station, steps, request)
      : provider === 'tidal'
        ? await replayTidalTrackMatch(steps, request)
        : await replayProviderSearchTask(task, steps, request)
  } finally {
    replay.assertComplete()
  }
}
