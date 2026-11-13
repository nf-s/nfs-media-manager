import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  CloudDispatchControlSchema,
  CloudDispatchJobIdsSchema,
} from '@repo/schemas/job'
import {
  CloudJobMessageSchema,
  CloudJobOutcomeSchema,
  type CloudJobMessage,
  type CloudJobOutcome,
} from '@/services/cloud-job-contract'

// Longer than a Queue invocation's 15-minute wall-clock limit. Never release a
// running slot merely because its Postgres job was cancelled: its fetch may live.
export const CLOUD_JOB_LEASE_MS = 16 * 60 * 1000
const OFFER_LEASE_MS = 60 * 1000
const MAX_DISPATCH = 32
const MAX_INFRASTRUCTURE_FAILURES = 8

const SlotSchema = CloudJobMessageSchema.extend({
  phase: z.enum(['offered', 'running']),
  expiresAt: z.number().int().nonnegative(),
  outcomeRecorded: z.boolean(),
})
const StateSchema = z.object({
  provider: z.string().min(1).max(200),
  paused: z.boolean(),
  allowedJobIds: CloudDispatchJobIdsSchema.default(null),
  stopped: z.boolean(),
  failures: z.number().int().nonnegative(),
  infrastructureFailures: z.number().int().nonnegative(),
  slots: z.array(SlotSchema).max(MAX_DISPATCH),
})
export type CloudJobCoordinatorState = z.infer<typeof StateSchema>

export interface CloudJobCoordinatorStorage {
  load(): Promise<unknown>
  // State and alarm must commit atomically in a Durable Object transaction.
  save(state: CloudJobCoordinatorState, alarmAt: number | null): Promise<void>
}

export interface CloudProviderDispatchPolicy {
  maxConcurrent: number
  blocked: boolean
  wakeAt: number | null
}

export interface CloudJobCoordinatorDependencies {
  storage: CloudJobCoordinatorStorage
  send(message: CloudJobMessage): Promise<void>
  policy(provider: string): Promise<CloudProviderDispatchPolicy>
  queued(
    provider: string,
    excludedIds: string[],
    limit: number,
    allowedJobIds?: string[] | null,
  ): Promise<string[]>
  recover(jobId: string, provider: string): Promise<void>
  /** Whether a provider's first stored state is paused. Defaults to paused. */
  initiallyPaused?: (provider: string) => Promise<boolean>
  now?: () => number
  token?: () => string
}

export class CloudJobCoordinator {
  private pending: Promise<unknown> = Promise.resolve()

  constructor(private readonly dependencies: CloudJobCoordinatorDependencies) {}

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }

  // Serialize only this provider's short control operations, not provider I/O.
  // All ownership survives eviction in storage; this promise is only a mutex.
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.catch(() => undefined)
    return result
  }

  private async state(
    provider?: string,
  ): Promise<CloudJobCoordinatorState | null> {
    const stored = await this.dependencies.storage.load()
    if (stored !== undefined && stored !== null) {
      const state = StateSchema.parse(stored)
      if (provider !== undefined && state.provider !== provider)
        throw new Error('Provider coordinator identity mismatch')
      return state
    }
    if (provider === undefined) return null
    const identity = CloudJobMessageSchema.shape.provider.parse(provider)
    return {
      provider: identity,
      paused: (await this.dependencies.initiallyPaused?.(identity)) ?? true,
      allowedJobIds: null,
      stopped: false,
      failures: 0,
      infrastructureFailures: 0,
      slots: [],
    }
  }

  private async save(
    state: CloudJobCoordinatorState,
    wakeAt: number | null = null,
    notBefore = this.now() + 1,
  ) {
    const deadlines = state.slots.map((slot) => slot.expiresAt)
    if (!state.paused && !state.stopped && wakeAt !== null)
      deadlines.push(wakeAt)
    await this.dependencies.storage.save(
      state,
      deadlines.length &&
        state.infrastructureFailures < MAX_INFRASTRUCTURE_FAILURES
        ? Math.max(notBefore, Math.min(...deadlines))
        : null,
    )
  }

  wake(provider: string): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.state(provider)
      if (state) await this.save(state, this.now() + 1)
    })
  }

  /**
   * The owner explicitly restarted work: clear a safety stop once its slots
   * are released. A pause and the job selection are left as they are.
   */
  resume(provider: string): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.state(provider)
      if (!state) return
      if (state.stopped && state.slots.length === 0) {
        state.stopped = false
        state.failures = 0
      }
      await this.save(state, this.now() + 1)
    })
  }

  getStatus(provider: string): Promise<CloudJobCoordinatorState | null> {
    return this.exclusive(() => this.state(provider))
  }

  setPaused(
    provider: string,
    paused: boolean,
    jobIds?: string[] | null,
  ): Promise<boolean> {
    return this.exclusive(async () => {
      const input = CloudDispatchControlSchema.parse({ paused, jobIds })
      const state = await this.state(provider)
      if (!state) return false
      if (input.jobIds !== undefined) {
        const previous = state.allowedJobIds
        const selection = input.jobIds
        const unchanged =
          previous === null || selection === null
            ? previous === selection
            : previous.length === selection.length &&
              previous.every((id) => selection.includes(id))
        if (!unchanged && state.slots.length > 0) return false
        state.allowedJobIds = selection
      }
      state.paused = input.paused
      if (!state.paused) state.infrastructureFailures = 0
      // An explicit resume must not clear an in-flight safety stop.
      if (!state.paused && state.slots.length === 0) {
        state.stopped = false
        state.failures = 0
      }
      await this.save(state, this.now() + 1)
      return true
    })
  }

  begin(input: CloudJobMessage): Promise<boolean> {
    return this.exclusive(async () => {
      const message = CloudJobMessageSchema.parse(input)
      const state = await this.state(message.provider)
      const slot = state?.slots.find(
        (entry) =>
          entry.token === message.token && entry.jobId === message.jobId,
      )
      if (
        !state ||
        !slot ||
        slot.phase !== 'offered' ||
        slot.expiresAt <= this.now() ||
        state.paused ||
        state.stopped
      )
        return false
      slot.phase = 'running'
      slot.expiresAt = this.now() + CLOUD_JOB_LEASE_MS
      await this.save(state)
      return true
    })
  }

  isActive(input: CloudJobMessage): Promise<boolean> {
    return this.exclusive(async () => {
      const message = CloudJobMessageSchema.parse(input)
      const state = await this.state(message.provider)
      return (
        state !== null &&
        !state.stopped &&
        state.slots.some(
          (slot) =>
            slot.token === message.token &&
            slot.jobId === message.jobId &&
            slot.phase === 'running' &&
            slot.expiresAt > this.now(),
        )
      )
    })
  }

  recordOutcome(
    input: CloudJobMessage,
    inputOutcome: CloudJobOutcome,
  ): Promise<void> {
    return this.exclusive(async () => {
      const message = CloudJobMessageSchema.parse(input)
      const outcome = CloudJobOutcomeSchema.parse(inputOutcome)
      const state = await this.state(message.provider)
      const slot = state?.slots.find(
        (entry) =>
          entry.token === message.token && entry.jobId === message.jobId,
      )
      if (!state || !slot || slot.phase !== 'running' || slot.outcomeRecorded)
        return
      slot.outcomeRecorded = true
      if (outcome === 'success' && !state.stopped) state.failures = 0
      if (outcome === 'failure') state.failures += 1
      if (outcome === 'stopped' || state.failures >= 2) state.stopped = true
      await this.save(state)
    })
  }

  finish(input: CloudJobMessage): Promise<void> {
    return this.exclusive(async () => {
      const message = CloudJobMessageSchema.parse(input)
      const state = await this.state(message.provider)
      if (!state) return
      const slot = state.slots.find(
        (entry) =>
          entry.token === message.token && entry.jobId === message.jobId,
      )
      if (!slot || slot.phase !== 'running') return
      state.slots = state.slots.filter((entry) => entry !== slot)
      await this.save(state, this.now() + 1)
    })
  }

  alarm(): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.state()
      if (!state) return
      if (state.infrastructureFailures >= MAX_INFRASTRUCTURE_FAILURES) {
        await this.save(state)
        return
      }
      // Arm recovery before external I/O, including on an alarm's final retry.
      await this.save(
        state,
        this.now() + OFFER_LEASE_MS,
        this.now() + OFFER_LEASE_MS,
      )
      try {
        for (const slot of [...state.slots]) {
          if (slot.expiresAt > this.now()) continue
          await this.dependencies.recover(slot.jobId, state.provider)
          state.slots = state.slots.filter((entry) => entry !== slot)
          await this.save(state, this.now() + OFFER_LEASE_MS)
        }
        if (state.paused || state.stopped) {
          await this.save(state)
          return
        }
        const policy = await this.dependencies.policy(state.provider)
        if (policy.blocked) {
          await this.save(state, policy.wakeAt)
          return
        }
        const capacity = Math.max(
          0,
          Math.min(MAX_DISPATCH, policy.maxConcurrent) - state.slots.length,
        )
        if (capacity === 0) {
          await this.save(state)
          return
        }
        const jobs = await this.dependencies.queued(
          state.provider,
          state.slots.map((slot) => slot.jobId),
          capacity,
          state.allowedJobIds,
        )
        for (const jobId of jobs.slice(0, capacity)) {
          const message = CloudJobMessageSchema.parse({
            version: 1,
            provider: state.provider,
            jobId,
            token: this.dependencies.token?.() ?? randomUUID(),
          })
          state.slots.push({
            ...message,
            phase: 'offered',
            expiresAt: this.now() + OFFER_LEASE_MS,
            outcomeRecorded: false,
          })
          await this.save(state)
          // An ambiguous send keeps its durable slot. Its expiry re-offers only
          // if Postgres still says queued; a running job is never replayed.
          await this.dependencies.send(message)
        }
        state.infrastructureFailures = 0
        await this.save(state)
      } catch (error) {
        state.infrastructureFailures += 1
        if (state.infrastructureFailures >= MAX_INFRASTRUCTURE_FAILURES)
          state.paused = true
        const backoff = Math.min(
          60 * 60 * 1000,
          1000 * 2 ** state.infrastructureFailures,
        )
        await this.save(state, this.now() + backoff, this.now() + backoff)
        throw error
      }
    })
  }
}
