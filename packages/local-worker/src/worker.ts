import { setTimeout as delay } from 'node:timers/promises'
import {
  LOCAL_RESPONSE_BYTES,
  LocalWorkerPermitSchema,
  LocalWorkerPollSchema,
  LocalWorkerResultSchema,
  isLocalWorkerUrlAllowed,
  type LocalWorkerPolicy,
  type LocalWorkerResult,
  type LocalWorkerTask,
} from '@repo/media-plugin-sdk/local-worker'
import { WorkerError, redact, type WorkerConfig } from './config.js'
import {
  BodyTooLargeError,
  DispatchExpiredError,
  abortable,
  httpsTransport,
  readBody,
  type Transport,
} from './http.js'
import { JournalStore } from './state.js'

interface ClockReading {
  wall: number
  monotonic: number
}
const clock = (): ClockReading => ({
  wall: Date.now(),
  monotonic: performance.now(),
})

export function elapsed(start: ClockReading, end: ClockReading): number {
  const wall = end.wall - start.wall
  const monotonic = end.monotonic - start.monotonic
  if (wall < 0 || monotonic < 0) return Infinity
  return Math.max(wall, monotonic)
}

export function policyAllowed(
  remote: LocalWorkerPolicy,
  config: WorkerConfig,
): boolean {
  const headers = remote.credentialHeaders.map((name) => name.toLowerCase())
  return (
    remote.origin === config.policy.origin &&
    remote.paths.every((path) => config.policy.paths.includes(path)) &&
    remote.queryParameters.every((name) =>
      config.policy.queryParameters.includes(name),
    ) &&
    new Set(headers).size === headers.length &&
    headers.length === Object.keys(config.credentials).length &&
    headers.every((name) => Object.hasOwn(config.credentials, name))
  )
}

export interface WorkerRuntime {
  transport: Transport
  clock: () => ClockReading
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
  requestTimeoutMs: number
  report: (event: string) => void
}

const defaults: WorkerRuntime = {
  transport: httpsTransport,
  clock,
  sleep: async (milliseconds, signal) => {
    await delay(milliseconds, undefined, { signal })
  },
  requestTimeoutMs: 30_000,
  report: () => {},
}

export class LocalWorker {
  private readonly runtime: WorkerRuntime

  constructor(
    private readonly config: WorkerConfig,
    private readonly store: JournalStore,
    runtime: Partial<WorkerRuntime> = {},
  ) {
    this.runtime = { ...defaults, ...runtime }
  }

  private async cloud(
    action: 'poll' | 'start' | 'result' | 'offline',
    body: unknown,
    signal: AbortSignal,
  ) {
    const response = await abortable(
      this.runtime.transport(
        `${this.config.appOrigin}/api/v1/local-worker/${this.config.provider}/${action}`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.config.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal,
        },
      ),
      signal,
    )
    if (response.status === 401 || response.status === 403) {
      void response.body?.cancel().catch(() => {})
      throw new WorkerError(
        'Worker authorization rejected; stopped without retry',
      )
    }
    return response
  }

  async offline(): Promise<void> {
    try {
      const response = await this.cloud(
        'offline',
        {},
        AbortSignal.timeout(3000),
      )
      void response.body?.cancel().catch(() => {})
      if (response.status < 200 || response.status >= 300)
        throw new Error('Offline notification rejected')
    } catch {
      this.runtime.report(
        'Offline notification unavailable; server heartbeat will expire',
      )
    }
  }

  private async upload(result: LocalWorkerResult, signal: AbortSignal) {
    let backoff = 1000
    while (!signal.aborted) {
      try {
        const requestSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(this.runtime.requestTimeoutMs),
        ])
        const response = await this.cloud('result', result, requestSignal)
        void response.body?.cancel().catch(() => {})
        if (response.status === 200) {
          this.store.acknowledge(result.id)
          this.runtime.report('Result acknowledged')
          return
        }
        if (response.status === 409)
          throw new WorkerError(
            'Result is stale or missing on server; journal retained for review',
          )
        if (response.status < 500 && response.status !== 429)
          throw new WorkerError('Result rejected; journal retained for review')
        throw new Error('Result upload unavailable')
      } catch (error) {
        if (error instanceof WorkerError) throw error
        if (signal.aborted) return
        this.runtime.report('Result upload unavailable; retained locally')
        await this.runtime.sleep(backoff, signal)
        backoff = Math.min(backoff * 2, 30_000)
      }
    }
  }

  private async execute(
    task: LocalWorkerTask,
    policy: LocalWorkerPolicy,
    signal: AbortSignal,
  ): Promise<LocalWorkerResult> {
    const failure = (
      error: 'policy' | 'expired' | 'interrupted',
    ): LocalWorkerResult => ({ kind: 'error', id: task.id, error })
    if (
      !policyAllowed(policy, this.config) ||
      !isLocalWorkerUrlAllowed(task.url, policy) ||
      !isLocalWorkerUrlAllowed(task.url, this.config.policy)
    )
      return failure('policy')
    if (signal.aborted) return failure('interrupted')
    const started = this.runtime.clock()
    let permit
    try {
      const startSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(this.runtime.requestTimeoutMs),
      ])
      const response = await this.cloud('start', { id: task.id }, startSignal)
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {})
        return failure(response.status === 409 ? 'expired' : 'interrupted')
      }
      permit = LocalWorkerPermitSchema.parse(
        JSON.parse(await readBody(response, 16_384, startSignal)),
      )
    } catch (error) {
      if (error instanceof WorkerError) {
        this.store.record(failure('interrupted'))
        throw error
      }
      return failure('interrupted')
    }
    // Include all start round-trip time and local processing. Absolute local wall
    // time is never compared with server epoch time; either clock can expire work.
    const remaining = () => ({
      dispatch:
        permit.dispatchBefore -
        permit.serverTime -
        elapsed(started, this.runtime.clock()) -
        500,
      expiry:
        permit.expiresAt -
        permit.serverTime -
        elapsed(started, this.runtime.clock()) -
        500,
    })
    const budget = remaining()
    if (budget.dispatch <= 0 || budget.expiry <= 0) return failure('expired')
    const timeout = AbortSignal.timeout(
      Math.max(
        1,
        Math.floor(Math.min(this.runtime.requestTimeoutMs, budget.expiry)),
      ),
    )
    const providerSignal = AbortSignal.any([signal, timeout])
    let response
    try {
      const finalBudget = remaining()
      if (providerSignal.aborted) return failure('interrupted')
      if (finalBudget.dispatch <= 0 || finalBudget.expiry <= 0)
        return failure('expired')
      // No await between the final deadline check and the only provider dispatch.
      response = await abortable(
        this.runtime.transport(task.url, {
          method: 'GET',
          headers: { ...this.config.credentials },
          signal: providerSignal,
          canDispatch: () => {
            const current = remaining()
            return (
              !providerSignal.aborted &&
              current.dispatch > 0 &&
              current.expiry > 0
            )
          },
        }),
        providerSignal,
      )
    } catch (error) {
      return {
        kind: 'error',
        id: task.id,
        error: signal.aborted
          ? 'interrupted'
          : error instanceof DispatchExpiredError
            ? 'expired'
            : timeout.aborted
              ? 'timeout'
              : error instanceof WorkerError
                ? 'policy'
                : 'network',
      }
    }
    const headers: Record<string, string> = {}
    for (const [key, value] of response.headers) {
      const clean = redact(value, this.config)
      if (
        LocalWorkerResultSchema.safeParse({
          kind: 'response',
          id: task.id,
          status: response.status,
          headers: { [key]: clean },
          body: '',
        }).success
      )
        headers[key] = clean
    }
    let body = ''
    try {
      body = redact(
        await readBody(response, LOCAL_RESPONSE_BYTES, providerSignal),
        this.config,
      )
      if (Buffer.byteLength(body) > LOCAL_RESPONSE_BYTES)
        throw new BodyTooLargeError()
    } catch (error) {
      if (response.status >= 200 && response.status < 300) {
        return {
          kind: 'error',
          id: task.id,
          error:
            error instanceof BodyTooLargeError
              ? 'response-too-large'
              : signal.aborted
                ? 'interrupted'
                : timeout.aborted
                  ? 'timeout'
                  : 'network',
        }
      }
      // Preserve access/rate-limit evidence even when an error body is unreadable.
      body = ''
    }
    const result = LocalWorkerResultSchema.safeParse({
      kind: 'response',
      id: task.id,
      status: response.status,
      headers,
      body,
    })
    return result.success ? result.data : failure('policy')
  }

  async run(signal: AbortSignal): Promise<void> {
    try {
      for (const id of this.store.pending()) {
        if (signal.aborted) return
        const result = this.store.readResult(id)
        this.store.record(result)
        await this.upload(result, signal)
      }
      let backoff = 1000
      while (!signal.aborted) {
        let poll
        try {
          const pollSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(this.runtime.requestTimeoutMs),
          ])
          const response = await this.cloud('poll', {}, pollSignal)
          if (response.status !== 200) {
            void response.body?.cancel().catch(() => {})
            if (response.status < 500 && response.status !== 429)
              throw new WorkerError('Poll rejected; stopped for review')
            throw new Error('Poll unavailable')
          }
          const raw = await readBody(response, 65_536, pollSignal)
          try {
            poll = LocalWorkerPollSchema.parse(JSON.parse(raw))
          } catch {
            throw new WorkerError('Invalid poll response; stopped for review')
          }
        } catch (error) {
          if (error instanceof WorkerError) throw error
          if (signal.aborted) return
          this.runtime.report('Connection unavailable; reconnecting')
          await this.runtime.sleep(backoff, signal)
          backoff = Math.min(backoff * 2, 30_000)
          continue
        }
        backoff = 1000
        if (!poll.task) {
          await this.runtime.sleep(250, signal)
          continue
        }
        const task = poll.task
        let result: LocalWorkerResult
        if (this.store.has(task.id)) result = this.store.readResult(task.id)
        else {
          this.store.claim(task.id)
          result = await this.execute(task, poll.policy, signal)
        }
        this.store.record(result)
        this.runtime.report(
          result.kind === 'response'
            ? `Provider response ${result.status}`
            : `Task failed: ${result.error}`,
        )
        await this.upload(result, signal)
      }
    } catch (error) {
      if (!signal.aborted) throw error
    }
  }
}
