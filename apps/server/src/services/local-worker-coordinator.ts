import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import {
  isLocalWorkerUrlAllowed,
  LocalWorkerPolicySchema,
  LocalWorkerResultSchema,
  LocalWorkerTaskSchema,
  type LocalWorkerPolicy,
  type LocalWorkerResult,
  type LocalWorkerTask,
} from '@repo/media-plugin-sdk/local-worker'

export const LOCAL_WORKER_HEARTBEAT_MS = 35000
const MAX_DISPATCH_WINDOW_MS = 4000
const TokenHashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const TaskStateSchema = z
  .object({
    task: LocalWorkerTaskSchema.refine(
      (task) => task.dispatchBefore < task.expiresAt,
    ),
    tokenHash: TokenHashSchema,
    phase: z.enum(['offered', 'consumed', 'started']),
    result: LocalWorkerResultSchema.nullable(),
  })
  .strict()
  .refine(
    (entry) =>
      entry.result === null ||
      (entry.result.id === entry.task.id &&
        entry.phase !== 'offered' &&
        (entry.result.kind !== 'response' || entry.phase === 'started')),
  )
const StateSchema = z
  .object({
    policy: LocalWorkerPolicySchema.nullable(),
    tokenHash: TokenHashSchema.nullable(),
    lastSeenAt: z.number().int().positive().nullable(),
    blocked: z.boolean(),
    active: TaskStateSchema.nullable(),
    retired: TaskStateSchema.nullable(),
  })
  .strict()
  .refine(
    (state) =>
      (state.policy !== null ||
        (state.tokenHash === null &&
          state.lastSeenAt === null &&
          state.active === null)) &&
      (state.active === null ||
        (state.policy !== null &&
          isLocalWorkerUrlAllowed(state.active.task.url, state.policy))) &&
      (state.active === null ||
        state.active.task.id !== state.retired?.task.id) &&
      (state.blocked || state.active?.result?.kind !== 'error'),
  )

export type LocalWorkerCoordinatorState = z.infer<typeof StateSchema>
export interface LocalWorkerCoordinatorStorage {
  load(): Promise<unknown>
  save(state: LocalWorkerCoordinatorState): Promise<void>
}
export interface LocalWorkerCoordinatorDependencies {
  storage: LocalWorkerCoordinatorStorage
  now?: () => number
}
export interface LocalWorkerCoordinatorStatus {
  configured: boolean
  online: boolean
  lastSeenAt: number | null
  blocked: boolean
  active: boolean
}

function matchesHash(expected: string | null, supplied: string): boolean {
  if (expected === null || !TokenHashSchema.safeParse(supplied).success)
    return false
  return timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(supplied, 'hex'),
  )
}

function identicalResult(a: LocalWorkerResult, b: LocalWorkerResult): boolean {
  if (a.id !== b.id || a.kind !== b.kind) return false
  if (a.kind === 'error' && b.kind === 'error') return a.error === b.error
  if (a.kind !== 'response' || b.kind !== 'response') return false
  return (
    a.status === b.status &&
    a.body === b.body &&
    Object.keys(a.headers).length === Object.keys(b.headers).length &&
    Object.entries(a.headers).every(([key, value]) => b.headers[key] === value)
  )
}

export class LocalWorkerCoordinator {
  private pending: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly dependencies: LocalWorkerCoordinatorDependencies,
  ) {}

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.catch(() => undefined)
    return result
  }

  private async state(): Promise<LocalWorkerCoordinatorState> {
    const stored = await this.dependencies.storage.load()
    const state =
      stored === undefined || stored === null
        ? StateSchema.parse({
            policy: null,
            tokenHash: null,
            lastSeenAt: null,
            blocked: false,
            active: null,
            retired: null,
          })
        : StateSchema.parse(stored)
    // A result without cloud acknowledgement may still contain unapplied safety evidence.
    const now = this.now()
    if (
      state.active &&
      !state.blocked &&
      (state.active.task.expiresAt <= now ||
        (state.active.phase !== 'started' &&
          state.active.task.dispatchBefore <= now))
    ) {
      state.blocked = true
      await this.dependencies.storage.save(state)
    }
    return state
  }

  private online(state: LocalWorkerCoordinatorState): boolean {
    const now = this.now()
    return (
      state.policy !== null &&
      state.tokenHash !== null &&
      state.lastSeenAt !== null &&
      state.lastSeenAt <= now &&
      now - state.lastSeenAt < LOCAL_WORKER_HEARTBEAT_MS
    )
  }

  configure(
    policy: LocalWorkerPolicy,
    tokenHash: string | null,
  ): Promise<boolean> {
    return this.exclusive(async () => {
      const parsedPolicy = LocalWorkerPolicySchema.parse(policy)
      const parsedHash = TokenHashSchema.nullable().parse(tokenHash)
      const state = await this.state()
      if (state.active) return false
      state.policy = parsedPolicy
      state.tokenHash = parsedHash
      state.lastSeenAt = null
      await this.dependencies.storage.save(state)
      return true
    })
  }

  revoke(): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.state()
      state.tokenHash = null
      state.lastSeenAt = null
      if (state.active) state.blocked = true
      await this.dependencies.storage.save(state)
    })
  }

  unconfigure(): Promise<boolean> {
    return this.exclusive(async () => {
      const state = await this.state()
      if (state.active || state.blocked) return false
      state.policy = null
      state.tokenHash = null
      state.lastSeenAt = null
      await this.dependencies.storage.save(state)
      return true
    })
  }

  status(): Promise<LocalWorkerCoordinatorStatus> {
    return this.exclusive(async () => {
      const state = await this.state()
      return {
        configured: state.policy !== null,
        online: this.online(state),
        lastSeenAt: state.lastSeenAt,
        blocked: state.blocked,
        active: state.active !== null,
      }
    })
  }

  getPolicy(): Promise<LocalWorkerPolicy | null> {
    return this.exclusive(async () => (await this.state()).policy)
  }

  authorize(hash: string): Promise<boolean> {
    return this.exclusive(async () =>
      matchesHash((await this.state()).tokenHash, hash),
    )
  }

  authorizeResult(hash: string): Promise<boolean> {
    return this.exclusive(async () => {
      const state = await this.state()
      const active = matchesHash(state.active?.tokenHash ?? null, hash)
      const retired = matchesHash(state.retired?.tokenHash ?? null, hash)
      return active || retired
    })
  }

  heartbeat(hash: string): Promise<boolean> {
    return this.exclusive(async () => {
      const state = await this.state()
      if (!matchesHash(state.tokenHash, hash)) return false
      state.lastSeenAt = this.now()
      await this.dependencies.storage.save(state)
      return true
    })
  }

  disconnect(hash: string): Promise<boolean> {
    return this.exclusive(async () => {
      const state = await this.state()
      if (!matchesHash(state.tokenHash, hash)) return false
      state.lastSeenAt = null
      await this.dependencies.storage.save(state)
      return true
    })
  }

  enqueue(input: LocalWorkerTask): Promise<boolean> {
    return this.exclusive(async () => {
      const task = LocalWorkerTaskSchema.parse(input)
      const state = await this.state()
      if (!state.policy || !state.tokenHash || !this.online(state))
        throw new Error('Local worker is unavailable')
      if (state.blocked) throw new Error('Local worker is blocked')
      if (state.active)
        throw new Error('Local worker already has an active request')
      if (state.retired?.task.id === task.id)
        throw new Error('Local worker request ID was already used')
      if (!isLocalWorkerUrlAllowed(task.url, state.policy))
        throw new Error('Local worker URL is not allowed')
      const now = this.now()
      if (
        task.dispatchBefore <= now ||
        task.dispatchBefore > now + MAX_DISPATCH_WINDOW_MS ||
        task.expiresAt <= task.dispatchBefore
      )
        throw new Error('Invalid local worker request deadlines')
      state.active = {
        task,
        tokenHash: state.tokenHash,
        phase: 'offered',
        result: null,
      }
      await this.dependencies.storage.save(state)
      return true
    })
  }

  take(hash: string): Promise<LocalWorkerTask | null> {
    return this.exclusive(async () => {
      const state = await this.state()
      const active = state.active
      if (
        !matchesHash(state.tokenHash, hash) ||
        !this.online(state) ||
        state.blocked ||
        !active ||
        active.phase !== 'offered' ||
        active.task.dispatchBefore <= this.now()
      )
        return null
      active.phase = 'consumed'
      await this.dependencies.storage.save(state)
      return active.task.dispatchBefore > this.now() ? active.task : null
    })
  }

  confirmStart(
    hash: string,
    id: string,
  ): Promise<{
    serverTime: number
    dispatchBefore: number
    expiresAt: number
  } | null> {
    return this.exclusive(async () => {
      const state = await this.state()
      const active = state.active
      if (
        !matchesHash(state.tokenHash, hash) ||
        !this.online(state) ||
        state.blocked ||
        !active ||
        active.task.id !== id ||
        active.phase !== 'consumed' ||
        active.result !== null ||
        active.task.dispatchBefore <= this.now()
      )
        return null
      active.phase = 'started'
      await this.dependencies.storage.save(state)
      const serverTime = this.now()
      if (active.task.dispatchBefore <= serverTime) return null
      return {
        serverTime,
        dispatchBefore: active.task.dispatchBefore,
        expiresAt: active.task.expiresAt,
      }
    })
  }

  result(hash: string, input: LocalWorkerResult): Promise<boolean> {
    return this.exclusive(async () => {
      const result = LocalWorkerResultSchema.parse(input)
      const state = await this.state()
      const entry =
        state.active?.task.id === result.id
          ? state.active
          : state.retired?.task.id === result.id
            ? state.retired
            : null
      // Revocation removes dispatch authority, not this task's result-only capability.
      if (
        !entry ||
        !matchesHash(entry.tokenHash, hash) ||
        entry.phase === 'offered'
      )
        return false
      if (entry.result) return identicalResult(entry.result, result)
      if (result.kind === 'response' && entry.phase !== 'started') return false
      entry.result = result
      if (result.kind === 'error') state.blocked = true
      await this.dependencies.storage.save(state)
      return true
    })
  }

  readResult(id: string): Promise<LocalWorkerResult | null> {
    return this.exclusive(async () => {
      const state = await this.state()
      if (state.active?.task.id === id) return state.active.result
      if (state.retired?.task.id === id) return state.retired.result
      return null
    })
  }

  expire(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const state = await this.state()
      return (
        state.active?.task.id === id &&
        state.active.task.expiresAt <= this.now()
      )
    })
  }

  consumeResult(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const state = await this.state()
      const active = state.active
      if (!active || active.task.id !== id) return false
      if (
        active.result?.kind !== 'response' &&
        active.task.expiresAt > this.now()
      )
        return false
      // Keep bounded late evidence; uncertainty prevents new work until owner review.
      state.retired = active
      state.active = null
      await this.dependencies.storage.save(state)
      return true
    })
  }

  getReviewResult(): Promise<LocalWorkerResult | null> {
    return this.exclusive(async () => {
      const state = await this.state()
      return state.active
        ? state.active.result
        : (state.retired?.result ?? null)
    })
  }

  review(): Promise<boolean> {
    return this.exclusive(async () => {
      const state = await this.state()
      const now = this.now()
      if (
        (state.active && state.active.task.expiresAt > now) ||
        (state.retired && state.retired.task.expiresAt > now)
      )
        return false
      if (state.active) state.retired = state.active
      state.active = null
      state.blocked = false
      await this.dependencies.storage.save(state)
      return true
    })
  }
}
