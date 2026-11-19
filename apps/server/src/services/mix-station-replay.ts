import { z } from 'zod'
import type { MixStation } from '@repo/schemas/subscriptions'
import { lotRadioActionId } from '@/lib/mix-station-archive'
import { createLotRadioAdapter } from '@/lib/lotradio-api'
import { createNtsAdapter } from '@/lib/nts-api'
import { createRinseAdapter } from '@/lib/rinse-api'
import type { StationRequest } from '@/lib/mix-station'
import type { ProviderTaskReplayStep } from './provider-task-replay'

const date = z.string().datetime()
const page = z.string().max(1024).nullable()
const handle = z.string().min(1).max(300)
const args = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('listShows'),
    args: z.object({ at: date, page }).strict(),
  }),
  z.object({
    operation: z.literal('listShowEpisodes'),
    args: z
      .object({
        at: date,
        page,
        show: z.object({ id: handle, handle }).strict(),
      })
      .strict(),
  }),
  z.object({
    operation: z.literal('listFeed'),
    args: z
      .object({
        at: date,
        page,
        mode: z.enum(['archive', 'recent']),
        since: date.nullable(),
        action: z.string().regex(lotRadioActionId).nullable(),
      })
      .strict(),
  }),
  z.object({
    operation: z.literal('getShow'),
    args: z.object({ at: date, handle }).strict(),
  }),
])

export function validateMixStationStep(step: ProviderTaskReplayStep) {
  return args.parse(step)
}

/** Re-run the same adapter calls, using saved inputs rather than mutable sync rows. */
export async function replayMixStationSteps(
  station: MixStation,
  steps: readonly ProviderTaskReplayStep[],
  request: StationRequest,
): Promise<unknown[]> {
  const results: unknown[] = []
  for (const step of steps.map(validateMixStationStep)) {
    const now = () => new Date(step.args.at)
    const adapter =
      station === 'rinse'
        ? createRinseAdapter(now)
        : station === 'nts'
          ? createNtsAdapter(now)
          : createLotRadioAdapter(
              now,
              step.operation === 'listFeed' ? step.args.action : null,
            )

    if (step.operation === 'listFeed') {
      if (station !== 'lotradio' && step.args.action !== null)
        throw new Error('Unexpected archive action for this station')
      results.push(
        await adapter.listFeed(
          request,
          step.args.mode,
          step.args.page,
          step.args.since === null ? null : new Date(step.args.since),
        ),
      )
    } else if (step.operation === 'getShow' && adapter.getShow) {
      results.push(await adapter.getShow(request, step.args.handle))
    } else if (step.operation === 'listShows' && adapter.catalogue) {
      results.push(await adapter.catalogue.listShows(request, step.args.page))
    } else if (step.operation === 'listShowEpisodes' && adapter.catalogue) {
      results.push(
        await adapter.catalogue.listShowEpisodes(
          request,
          step.args.show,
          step.args.page,
        ),
      )
    } else {
      throw new Error('Unsupported station replay step')
    }
  }
  return results
}
