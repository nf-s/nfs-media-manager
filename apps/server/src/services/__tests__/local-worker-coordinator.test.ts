import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LocalWorkerPolicySchema,
  LocalWorkerResultSchema,
  type LocalWorkerResult,
  type LocalWorkerTask,
} from '@repo/media-plugin-sdk/local-worker'
import {
  LOCAL_WORKER_HEARTBEAT_MS,
  LocalWorkerCoordinator,
  type LocalWorkerCoordinatorDependencies,
} from '@/services/local-worker-coordinator'
import { LOCAL_WORKER_DISPATCH_WINDOW_MS } from '@/services/provider-transport'

const hash = 'a'.repeat(64)
const otherHash = 'b'.repeat(64)
const id = '00000000-0000-4000-8000-000000000001'
const otherId = '00000000-0000-4000-8000-000000000002'
const policy = LocalWorkerPolicySchema.parse({
  origin: 'https://provider.invalid',
  paths: ['/lookup'],
  credentialHeaders: ['X-Fixture-Key'],
  queryParameters: ['id'],
})

function fixture() {
  let stored: unknown
  let now = 1000
  const dependencies: LocalWorkerCoordinatorDependencies = {
    storage: {
      load: vi.fn(async () => structuredClone(stored)),
      save: vi.fn(async (state) => {
        stored = structuredClone(state)
      }),
    },
    now: () => now,
  }
  const coordinator = new LocalWorkerCoordinator(dependencies)
  const task: LocalWorkerTask = {
    id,
    url: 'https://provider.invalid/lookup?id=fixture',
    dispatchBefore: 5000,
    expiresAt: 25000,
  }
  return {
    coordinator,
    dependencies,
    task,
    setNow(value: number) {
      now = value
    },
    stored: () => structuredClone(stored),
    replaceStored(value: unknown) {
      stored = structuredClone(value)
    },
    recreate: () => new LocalWorkerCoordinator(dependencies),
    async ready() {
      expect(await coordinator.configure(policy, hash)).toBe(true)
      expect(await coordinator.heartbeat(hash)).toBe(true)
    },
    async start() {
      await this.ready()
      expect(await coordinator.enqueue(task)).toBe(true)
      expect(await coordinator.take(hash)).toEqual(task)
      expect(await coordinator.confirmStart(hash, id)).not.toBeNull()
    },
  }
}

function response(status = 200): LocalWorkerResult {
  return LocalWorkerResultSchema.parse({
    kind: 'response',
    id,
    status,
    headers: { 'content-type': 'application/json', 'retry-after': '60' },
    body: '{}',
  })
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Outbound requests are forbidden in coordinator tests')
    }),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('local worker coordinator', () => {
  describe('waiting for tasks', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('waits ten seconds while idle without repeatedly reading storage', async () => {
      const f = fixture()
      await f.ready()
      vi.mocked(f.dependencies.storage.load).mockClear()
      vi.mocked(f.dependencies.storage.save).mockClear()
      const completed = vi.fn()
      const waiting = f.coordinator.waitForTask(hash).then(completed)
      await vi.advanceTimersByTimeAsync(9999)
      expect(completed).not.toHaveBeenCalled()
      expect(f.dependencies.storage.load).toHaveBeenCalledOnce()
      expect(f.dependencies.storage.save).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await waiting
      expect(completed).toHaveBeenCalledExactlyOnceWith(false)
      expect(f.dependencies.storage.load).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    })

    it.each([
      { maxWaitMs: 0, expectedWaitMs: 0 },
      { maxWaitMs: 250, expectedWaitMs: 250 },
      { maxWaitMs: 20000, expectedWaitMs: 10000 },
    ])(
      'bounds an idle wait of $maxWaitMs ms to $expectedWaitMs ms',
      async ({ maxWaitMs, expectedWaitMs }) => {
        const f = fixture()
        await f.ready()
        const completed = vi.fn()
        const waiting = f.coordinator
          .waitForTask(hash, maxWaitMs)
          .then(completed)
        if (expectedWaitMs > 0) {
          await vi.advanceTimersByTimeAsync(expectedWaitMs - 1)
          expect(completed).not.toHaveBeenCalled()
          await vi.advanceTimersByTimeAsync(1)
        } else await vi.advanceTimersByTimeAsync(0)
        await waiting
        expect(completed).toHaveBeenCalledExactlyOnceWith(false)
        expect(vi.getTimerCount()).toBe(0)
      },
    )

    it.each([-1, 0.5, NaN, Infinity, -Infinity])(
      'rejects an invalid wait limit %s before registering a waiter',
      async (maxWaitMs) => {
        const f = fixture()
        await expect(
          f.coordinator.waitForTask(hash, maxWaitMs),
        ).rejects.toThrow()
        expect(f.dependencies.storage.load).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
      },
    )

    it('wakes immediately after enqueue commits without consuming the offer', async () => {
      const f = fixture()
      await f.ready()
      const completed = vi.fn()
      const waiting = f.coordinator.waitForTask(hash).then(completed)
      await vi.advanceTimersByTimeAsync(0)
      vi.mocked(f.dependencies.storage.save).mockImplementationOnce(
        async (state) => {
          await new Promise<void>((resolve) => setTimeout(resolve, 1000))
          f.replaceStored(state)
        },
      )
      const enqueued = f.coordinator.enqueue(f.task)
      await vi.advanceTimersByTimeAsync(999)
      expect(completed).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(await enqueued).toBe(true)
      await waiting
      expect(completed).toHaveBeenCalledExactlyOnceWith(true)
      expect(f.stored()).toMatchObject({ active: { phase: 'offered' } })
      expect(vi.getTimerCount()).toBe(0)
      expect(await f.coordinator.take(hash)).toEqual(f.task)
    })

    it('does not miss an enqueue racing the initial check or consume for concurrent waiters', async () => {
      const f = fixture()
      await f.ready()
      const first = f.coordinator.waitForTask(hash)
      const second = f.coordinator.waitForTask(hash)
      const unauthorized = f.coordinator.waitForTask(otherHash)
      await f.coordinator.enqueue(f.task)
      expect(await Promise.all([first, second, unauthorized])).toEqual([
        true,
        true,
        false,
      ])
      expect(vi.getTimerCount()).toBe(0)
      expect(
        await Promise.all([f.coordinator.take(hash), f.coordinator.take(hash)]),
      ).toEqual([f.task, null])
    })

    it('returns an existing eligible offer immediately without changing it', async () => {
      const f = fixture()
      await f.ready()
      await f.coordinator.enqueue(f.task)
      const stored = f.stored()
      expect(await f.coordinator.waitForTask(hash)).toBe(true)
      expect(f.stored()).toEqual(stored)
      expect(vi.getTimerCount()).toBe(0)
    })

    it.each(['cloud', 'unpaired', 'offline', 'blocked'])(
      'returns no task when the worker is %s',
      async (state) => {
        const f = fixture()
        await f.ready()
        if (state === 'cloud') await f.coordinator.setMode('cloud')
        else if (state === 'unpaired') await f.coordinator.revoke()
        else if (state === 'offline') await f.coordinator.disconnect(hash)
        else {
          await f.coordinator.enqueue(f.task)
          await f.coordinator.take(hash)
          await f.coordinator.result(hash, {
            kind: 'error',
            id,
            error: 'interrupted',
          })
        }
        const waiting = f.coordinator.waitForTask(hash)
        await vi.advanceTimersByTimeAsync(10000)
        expect(await waiting).toBe(false)
        expect(vi.getTimerCount()).toBe(0)
      },
    )

    it.each(['revoke', 'disconnect', 'take'])(
      'revalidates eligibility after a wake racing %s',
      async (operation) => {
        const f = fixture()
        await f.ready()
        const waiting = f.coordinator.waitForTask(hash)
        const enqueued = f.coordinator.enqueue(f.task)
        const changed =
          operation === 'revoke'
            ? f.coordinator.revoke()
            : operation === 'disconnect'
              ? f.coordinator.disconnect(hash)
              : f.coordinator.take(hash)
        await enqueued
        await changed
        expect(await waiting).toBe(false)
        expect(vi.getTimerCount()).toBe(0)
      },
    )

    it('rechecks the dispatch deadline after enqueue storage completes', async () => {
      const f = fixture()
      await f.ready()
      const waiting = f.coordinator.waitForTask(hash)
      vi.mocked(f.dependencies.storage.save).mockImplementationOnce(
        async (state) => {
          f.replaceStored(state)
          f.setNow(f.task.dispatchBefore)
        },
      )
      await f.coordinator.enqueue(f.task)
      expect(await waiting).toBe(false)
      expect(f.stored()).toMatchObject({
        blocked: true,
        active: { phase: 'offered' },
      })
      expect(vi.getTimerCount()).toBe(0)
    })

    it('does not wake early after a rejected enqueue', async () => {
      const f = fixture()
      await f.ready()
      const completed = vi.fn()
      const waiting = f.coordinator.waitForTask(hash).then(completed)
      vi.mocked(f.dependencies.storage.save).mockRejectedValueOnce(
        new Error('Storage unavailable'),
      )
      await expect(f.coordinator.enqueue(f.task)).rejects.toThrow(
        'Storage unavailable',
      )
      await vi.advanceTimersByTimeAsync(9999)
      expect(completed).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await waiting
      expect(completed).toHaveBeenCalledExactlyOnceWith(false)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('cleans up failed waits and leaves later waits usable', async () => {
      const f = fixture()
      await f.ready()
      vi.mocked(f.dependencies.storage.load).mockRejectedValueOnce(
        new Error('Storage unavailable'),
      )
      await expect(f.coordinator.waitForTask(hash)).rejects.toThrow(
        'Storage unavailable',
      )
      expect(vi.getTimerCount()).toBe(0)
      const waiting = f.coordinator.waitForTask(hash)
      await f.coordinator.enqueue(f.task)
      expect(await waiting).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('cleans up when the state check after a wake fails', async () => {
      const f = fixture()
      await f.ready()
      const waiting = f.coordinator.waitForTask(hash)
      await vi.advanceTimersByTimeAsync(0)
      vi.mocked(f.dependencies.storage.load)
        .mockImplementationOnce(async () => f.stored())
        .mockRejectedValueOnce(new Error('Storage unavailable'))
      const failed = expect(waiting).rejects.toThrow('Storage unavailable')
      await f.coordinator.enqueue(f.task)
      await failed
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  it('keeps local-by-default providers local while unpaired', async () => {
    const f = fixture()
    expect(await f.coordinator.status('local')).toMatchObject({
      mode: 'local',
      paired: false,
      online: false,
    })
    expect(f.dependencies.storage.save).not.toHaveBeenCalled()
  })

  it('retains a hidden worker capability across cloud and local switches', async () => {
    const f = fixture()
    await f.ready()
    expect(await f.coordinator.setMode('cloud')).toBe(true)
    expect(await f.recreate().status('local')).toMatchObject({
      mode: 'cloud',
      configured: true,
      paired: true,
      online: true,
    })
    expect(await f.coordinator.heartbeat(hash)).toBe(true)
    await expect(f.coordinator.enqueue(f.task)).rejects.toThrow('unavailable')
    expect(await f.coordinator.take(hash)).toBeNull()
    expect(await f.coordinator.confirmStart(hash, id)).toBeNull()

    expect(await f.coordinator.setMode('local')).toBe(true)
    expect(await f.recreate().status('local')).toMatchObject({
      mode: 'local',
      paired: true,
      online: true,
    })
    expect(await f.coordinator.enqueue(f.task)).toBe(true)
    expect(await f.coordinator.take(hash)).toEqual(f.task)
  })

  it('rejects transport changes while a local request is active or unresolved', async () => {
    const f = fixture()
    await f.start()
    expect(await f.coordinator.setMode('cloud')).toBe(false)
    f.setNow(f.task.expiresAt)
    expect(await f.coordinator.consumeResult(id)).toBe(true)
    expect(await f.coordinator.setMode('cloud')).toBe(false)
    expect(await f.coordinator.review()).toBe(true)
    expect(await f.coordinator.setMode('cloud')).toBe(true)
  })

  it('preserves legacy configured and revoked states without a stored mode', async () => {
    const f = fixture()
    f.replaceStored({
      policy,
      tokenHash: null,
      lastSeenAt: null,
      blocked: false,
      active: null,
      retired: null,
    })
    expect(await f.coordinator.status()).toMatchObject({
      mode: 'local',
      configured: true,
      paired: false,
      online: false,
    })
    expect(await f.coordinator.unconfigure()).toBe(true)
    expect(await f.coordinator.status()).toMatchObject({
      mode: 'cloud',
      configured: false,
      paired: false,
    })
  })

  it('returns sanitized default status without writes', async () => {
    const f = fixture()
    expect(await f.coordinator.status()).toEqual({
      mode: 'cloud',
      configured: false,
      paired: false,
      online: false,
      lastSeenAt: null,
      blocked: false,
      active: false,
    })
    expect(await f.coordinator.getPolicy()).toBeNull()
    expect(await f.coordinator.authorize(hash)).toBe(false)
    expect(await f.coordinator.authorizeResult(hash)).toBe(false)
    expect(await f.coordinator.getReviewResult()).toBeNull()
    expect(f.dependencies.storage.save).not.toHaveBeenCalled()
  })

  it('requires a matching hash and fresh heartbeat without exposing secrets', async () => {
    const f = fixture()
    await f.coordinator.configure(policy, hash)
    expect(await f.coordinator.authorize(hash)).toBe(true)
    expect(await f.coordinator.authorize(otherHash)).toBe(false)
    expect(await f.coordinator.authorize('invalid')).toBe(false)
    expect(await f.coordinator.heartbeat(otherHash)).toBe(false)
    expect((await f.coordinator.status()).online).toBe(false)
    await f.coordinator.heartbeat(hash)
    expect(await f.coordinator.status()).toEqual({
      mode: 'local',
      configured: true,
      paired: true,
      online: true,
      lastSeenAt: 1000,
      blocked: false,
      active: false,
    })
    expect(await f.coordinator.getPolicy()).toEqual(policy)
    f.setNow(1000 + LOCAL_WORKER_HEARTBEAT_MS - 1)
    expect((await f.recreate().status()).online).toBe(true)
    f.setNow(1000 + LOCAL_WORKER_HEARTBEAT_MS)
    expect((await f.coordinator.status()).online).toBe(false)
    await f.coordinator.heartbeat(hash)
    f.setNow(1000)
    expect((await f.coordinator.status()).online).toBe(false)
  })

  it('keeps independently configured coordinators and tokens isolated', async () => {
    const a = fixture()
    const b = fixture()
    await a.ready()
    await b.coordinator.configure(policy, otherHash)
    expect(await b.coordinator.heartbeat(hash)).toBe(false)
    expect(await a.coordinator.heartbeat(otherHash)).toBe(false)
    expect(await b.coordinator.authorize(hash)).toBe(false)
    expect(await a.coordinator.enqueue(a.task)).toBe(true)
    expect(await b.coordinator.take(hash)).toBeNull()
  })

  it('disconnects only the current token without revoking or altering active work', async () => {
    const f = fixture()
    await f.start()
    const before = f.stored()
    expect(await f.coordinator.disconnect(otherHash)).toBe(false)
    expect(f.stored()).toEqual(before)
    expect(await f.coordinator.disconnect(hash)).toBe(true)
    expect(await f.recreate().status()).toEqual({
      mode: 'local',
      configured: true,
      paired: true,
      online: false,
      lastSeenAt: null,
      blocked: false,
      active: true,
    })
    expect(f.stored()).toMatchObject({
      tokenHash: hash,
      active: { task: f.task, phase: 'started', result: null },
    })
    expect(await f.coordinator.authorize(hash)).toBe(true)
    expect(await f.coordinator.result(hash, response(403))).toBe(true)
    expect(await f.coordinator.heartbeat(hash)).toBe(true)
    expect((await f.coordinator.status()).online).toBe(true)
    await f.coordinator.revoke()
    expect(await f.coordinator.disconnect(hash)).toBe(false)
    expect((await f.coordinator.status()).blocked).toBe(true)
  })

  it('does not clear a latched block on disconnect or reconnect', async () => {
    const f = fixture()
    await f.start()
    await f.coordinator.result(hash, { kind: 'error', id, error: 'timeout' })
    expect(await f.coordinator.disconnect(hash)).toBe(true)
    expect(await f.coordinator.status()).toMatchObject({
      online: false,
      active: true,
      blocked: true,
    })
    await f.coordinator.heartbeat(hash)
    expect(await f.coordinator.status()).toMatchObject({
      online: true,
      active: true,
      blocked: true,
    })
  })

  it('rejects offline or occupied enqueue instead of silently dropping it', async () => {
    const f = fixture()
    await expect(f.coordinator.enqueue(f.task)).rejects.toThrow('unavailable')
    await f.coordinator.configure(policy, hash)
    await expect(f.coordinator.enqueue(f.task)).rejects.toThrow('unavailable')
    await f.coordinator.heartbeat(hash)
    await f.coordinator.enqueue(f.task)
    await expect(
      f.coordinator.enqueue({ ...f.task, id: otherId }),
    ).rejects.toThrow('active request')
    expect(await f.coordinator.configure(policy, otherHash)).toBe(false)
    expect(await f.coordinator.unconfigure()).toBe(false)
    expect((await f.coordinator.status()).active).toBe(true)
  })

  it.each([
    'http://provider.invalid/lookup',
    'https://other.invalid/lookup',
    'https://provider.invalid:444/lookup',
    'https://provider.invalid/lookup/extra',
    'https://provider.invalid/lookup?token=secret',
    'https://provider.invalid/lookup?id=a&id=b',
    'https://user:password@provider.invalid/lookup',
    'https://provider.invalid/lookup#fragment',
  ])('rejects non-allowlisted URL %s', async (url) => {
    const f = fixture()
    await f.ready()
    await expect(f.coordinator.enqueue({ ...f.task, url })).rejects.toThrow(
      'not allowed',
    )
    expect((await f.coordinator.status()).active).toBe(false)
  })

  it.each([
    { dispatchBefore: 1000, expiresAt: 25000 },
    {
      dispatchBefore: 1000 + LOCAL_WORKER_DISPATCH_WINDOW_MS + 1,
      expiresAt: 25000,
    },
    { dispatchBefore: 5000, expiresAt: 5000 },
  ])('rejects invalid execution deadlines %j', async (deadlines) => {
    const f = fixture()
    await f.ready()
    await expect(
      f.coordinator.enqueue({ ...f.task, ...deadlines }),
    ).rejects.toThrow('deadlines')
  })

  it('still grants exactly one start permit after more than four seconds of handoff', async () => {
    const f = fixture()
    await f.ready()
    const task = {
      ...f.task,
      dispatchBefore: 1000 + LOCAL_WORKER_DISPATCH_WINDOW_MS,
    }
    await f.coordinator.enqueue(task)
    f.setNow(4500)
    expect(await f.coordinator.take(hash)).toEqual(task)
    f.setNow(6000)
    expect(await f.coordinator.confirmStart(hash, id)).toEqual({
      serverTime: 6000,
      dispatchBefore: task.dispatchBefore,
      expiresAt: task.expiresAt,
    })
    expect(await f.coordinator.confirmStart(hash, id)).toBeNull()
  })

  it('persists take before returning and never redelivers after restart', async () => {
    const f = fixture()
    await f.ready()
    await f.coordinator.enqueue(f.task)
    expect(await f.coordinator.take(otherHash)).toBeNull()
    expect(
      await Promise.all([f.coordinator.take(hash), f.coordinator.take(hash)]),
    ).toEqual([f.task, null])
    expect(f.stored()).toMatchObject({ active: { phase: 'consumed' } })
    expect(await f.recreate().take(hash)).toBeNull()
    expect(await f.recreate().readResult(id)).toBeNull()
  })

  it('requires take and matching identity before issuing a single-use start permit', async () => {
    const f = fixture()
    await f.ready()
    await f.coordinator.enqueue(f.task)
    expect(await f.coordinator.confirmStart(hash, id)).toBeNull()
    await f.coordinator.take(hash)
    expect(await f.coordinator.confirmStart(otherHash, id)).toBeNull()
    expect(await f.coordinator.confirmStart(hash, otherId)).toBeNull()
    expect(
      await Promise.all([
        f.coordinator.confirmStart(hash, id),
        f.coordinator.confirmStart(hash, id),
      ]),
    ).toEqual([
      { serverTime: 1000, dispatchBefore: 5000, expiresAt: 25000 },
      null,
    ])
    expect(f.stored()).toMatchObject({ active: { phase: 'started' } })
    expect(await f.recreate().confirmStart(hash, id)).toBeNull()
  })

  it('rejects stale takes and permits at the dispatch deadline without releasing the slot', async () => {
    const f = fixture()
    await f.ready()
    await f.coordinator.enqueue(f.task)
    f.setNow(5000)
    expect(await f.coordinator.take(hash)).toBeNull()
    expect(await f.coordinator.confirmStart(hash, id)).toBeNull()
    expect(await f.coordinator.consumeResult(id)).toBe(false)
    expect(await f.coordinator.expire(id)).toBe(false)
    expect((await f.coordinator.status()).active).toBe(true)
    expect((await f.coordinator.status()).blocked).toBe(true)
  })

  it('blocks a consumed task when its start window lapses without releasing its horizon', async () => {
    const f = fixture()
    await f.ready()
    await f.coordinator.enqueue(f.task)
    await f.coordinator.take(hash)
    f.setNow(5000)
    expect(await f.coordinator.heartbeat(hash)).toBe(true)
    expect(await f.coordinator.status()).toMatchObject({
      active: true,
      blocked: true,
    })
    expect(await f.coordinator.confirmStart(hash, id)).toBeNull()
    expect(await f.coordinator.review()).toBe(false)
  })

  it('rechecks permit deadlines after durable storage completes', async () => {
    const f = fixture()
    await f.ready()
    await f.coordinator.enqueue(f.task)
    await f.coordinator.take(hash)
    vi.mocked(f.dependencies.storage.save).mockImplementationOnce(
      async (state) => {
        f.replaceStored(state)
        f.setNow(5000)
      },
    )
    expect(await f.coordinator.confirmStart(hash, id)).toBeNull()
    expect(f.stored()).toMatchObject({ active: { phase: 'started' } })
    expect(await f.recreate().confirmStart(hash, id)).toBeNull()
  })

  it.each(['take', 'confirmStart'])(
    'does not repeat %s after an ambiguous durable save',
    async (method) => {
      const f = fixture()
      await f.ready()
      await f.coordinator.enqueue(f.task)
      if (method === 'confirmStart') await f.coordinator.take(hash)
      vi.mocked(f.dependencies.storage.save).mockImplementationOnce(
        async (state) => {
          f.replaceStored(state)
          throw new Error('Storage acknowledgement lost')
        },
      )
      const operation =
        method === 'take'
          ? f.coordinator.take(hash)
          : f.coordinator.confirmStart(hash, id)
      await expect(operation).rejects.toThrow('acknowledgement lost')
      expect(await f.recreate().take(hash)).toBeNull()
      if (method === 'confirmStart')
        expect(await f.recreate().confirmStart(hash, id)).toBeNull()
    },
  )

  it('accepts identical results idempotently and rejects conflicting results', async () => {
    const f = fixture()
    await f.start()
    expect(await f.coordinator.result(otherHash, response())).toBe(false)
    expect(
      await f.coordinator.result(hash, { ...response(), id: otherId }),
    ).toBe(false)
    const result = response()
    expect(await f.coordinator.result(hash, result)).toBe(true)
    const saves = vi.mocked(f.dependencies.storage.save).mock.calls.length
    expect(await f.recreate().result(hash, result)).toBe(true)
    expect(f.dependencies.storage.save).toHaveBeenCalledTimes(saves)
    expect(await f.coordinator.result(hash, response(403))).toBe(false)
    expect(await f.coordinator.readResult(id)).toEqual(result)
    expect(await f.coordinator.getReviewResult()).toEqual(result)
  })

  it('compares response headers independently of JSON property order', async () => {
    const f = fixture()
    await f.start()
    await f.coordinator.result(hash, response())
    expect(
      await f.coordinator.result(
        hash,
        LocalWorkerResultSchema.parse({
          kind: 'response',
          id,
          status: 200,
          body: '{}',
          headers: { 'retry-after': '60', 'content-type': 'application/json' },
        }),
      ),
    ).toBe(true)
  })

  it('does not accept provider responses without a start permit', async () => {
    const f = fixture()
    await f.ready()
    await f.coordinator.enqueue(f.task)
    expect(await f.coordinator.result(hash, response())).toBe(false)
    await f.coordinator.take(hash)
    expect(await f.coordinator.result(hash, response())).toBe(false)
    expect(
      await f.coordinator.result(hash, { kind: 'error', id, error: 'policy' }),
    ).toBe(true)
    expect(await f.coordinator.confirmStart(hash, id)).toBeNull()
  })

  it.each([
    'network',
    'timeout',
    'interrupted',
    'policy',
    'expired',
    'response-too-large',
  ])(
    'blocks on %s and retains the slot until the full execution horizon',
    async (error) => {
      const f = fixture()
      await f.start()
      const result = LocalWorkerResultSchema.parse({ kind: 'error', id, error })
      expect(await f.coordinator.result(hash, result)).toBe(true)
      expect((await f.recreate().status()).blocked).toBe(true)
      expect(await f.coordinator.consumeResult(id)).toBe(false)
      f.setNow(24999)
      expect(await f.coordinator.consumeResult(id)).toBe(false)
      f.setNow(25000)
      expect(await f.coordinator.consumeResult(id)).toBe(true)
      expect(await f.coordinator.readResult(id)).toEqual(result)
      expect(await f.coordinator.status()).toMatchObject({
        active: false,
        blocked: true,
      })
      await expect(
        f.coordinator.enqueue({
          ...f.task,
          id: otherId,
          dispatchBefore: 29000,
          expiresAt: 49000,
        }),
      ).rejects.toThrow('blocked')
    },
  )

  it.each(['status', 'heartbeat', 'enqueue'])(
    'automatically latches expiry through %s without an expiry call',
    async (operation) => {
      const f = fixture()
      await f.start()
      f.setNow(25000)
      if (operation === 'heartbeat') await f.coordinator.heartbeat(hash)
      else if (operation === 'enqueue')
        await expect(
          f.coordinator.enqueue({
            ...f.task,
            id: otherId,
            dispatchBefore: 29000,
            expiresAt: 49000,
          }),
        ).rejects.toThrow('blocked')
      else await f.coordinator.status()
      expect(f.stored()).toMatchObject({ blocked: true })
      expect((await f.recreate().status()).blocked).toBe(true)
    },
  )

  it('blocks if a response was never acknowledged by the cloud caller', async () => {
    const f = fixture()
    await f.start()
    await f.coordinator.result(hash, response(429))
    f.setNow(25000)
    expect((await f.coordinator.status()).blocked).toBe(true)
    expect(await f.coordinator.getReviewResult()).toEqual(response(429))
    expect(await f.coordinator.consumeResult(id)).toBe(true)
    expect((await f.coordinator.status()).blocked).toBe(true)
  })

  it('retains late evidence after timeout cleanup without granting another permit', async () => {
    const f = fixture()
    await f.start()
    expect(await f.coordinator.expire(otherId)).toBe(false)
    expect(await f.coordinator.consumeResult(otherId)).toBe(false)
    f.setNow(25000)
    expect(await f.coordinator.expire(id)).toBe(true)
    expect(await f.coordinator.consumeResult(id)).toBe(true)
    expect(await f.coordinator.readResult(id)).toBeNull()
    expect(await f.recreate().result(hash, response(403))).toBe(true)
    expect(await f.coordinator.readResult(id)).toEqual(response(403))
    expect(await f.coordinator.confirmStart(hash, id)).toBeNull()
    expect(await f.coordinator.take(hash)).toBeNull()
    expect(await f.coordinator.status()).toMatchObject({
      active: false,
      blocked: true,
    })
  })

  it('revokes dispatch authority but preserves matching result-only authority', async () => {
    const f = fixture()
    await f.start()
    await f.coordinator.revoke()
    expect(await f.coordinator.status()).toMatchObject({
      configured: true,
      online: false,
      blocked: true,
      active: true,
    })
    expect(await f.coordinator.authorize(hash)).toBe(false)
    expect(await f.coordinator.heartbeat(hash)).toBe(false)
    expect(await f.coordinator.take(hash)).toBeNull()
    expect(await f.coordinator.confirmStart(hash, id)).toBeNull()
    expect(await f.coordinator.authorizeResult(hash)).toBe(true)
    expect(await f.coordinator.authorizeResult(otherHash)).toBe(false)
    expect(await f.coordinator.result(otherHash, response(403))).toBe(false)
    expect(await f.coordinator.result(hash, response(403))).toBe(true)
    expect(await f.coordinator.consumeResult(id)).toBe(true)
    expect(await f.recreate().authorizeResult(hash)).toBe(true)
    expect(await f.coordinator.readResult(id)).toEqual(response(403))
    expect(await f.coordinator.unconfigure()).toBe(false)
  })

  it('revocation before take prevents delivery while preserving the possible horizon', async () => {
    const f = fixture()
    await f.ready()
    await f.coordinator.enqueue(f.task)
    await f.coordinator.revoke()
    expect(await f.coordinator.take(hash)).toBeNull()
    expect(await f.coordinator.result(hash, response())).toBe(false)
    expect(await f.coordinator.consumeResult(id)).toBe(false)
    expect(await f.coordinator.review()).toBe(false)
  })

  it('does not clear uncertainty on re-pairing or unconfiguration', async () => {
    const f = fixture()
    await f.start()
    f.setNow(25000)
    await f.coordinator.consumeResult(id)
    expect(await f.coordinator.configure(policy, otherHash)).toBe(true)
    expect(await f.coordinator.heartbeat(hash)).toBe(false)
    expect(await f.coordinator.heartbeat(otherHash)).toBe(true)
    expect(await f.coordinator.unconfigure()).toBe(false)
    expect((await f.coordinator.status()).blocked).toBe(true)
    expect(await f.coordinator.result(otherHash, response(429))).toBe(false)
    expect(await f.coordinator.result(hash, response(429))).toBe(true)
  })

  it('permits cleanup of confirmed responses and rejects recent request ID reuse', async () => {
    const f = fixture()
    await f.start()
    await f.coordinator.result(hash, response())
    expect(await f.coordinator.consumeResult(id)).toBe(true)
    expect(await f.coordinator.consumeResult(id)).toBe(false)
    expect(await f.recreate().result(hash, response())).toBe(true)
    await expect(f.coordinator.enqueue(f.task)).rejects.toThrow('already used')
    expect(await f.coordinator.enqueue({ ...f.task, id: otherId })).toBe(true)
    expect(await f.coordinator.status()).toMatchObject({
      blocked: false,
      active: true,
    })
  })

  it('allows explicit unconfiguration only when safe and keeps revocation configured', async () => {
    const f = fixture()
    await f.ready()
    await f.coordinator.revoke()
    expect(await f.coordinator.status()).toMatchObject({
      configured: true,
      online: false,
    })
    expect(await f.coordinator.unconfigure()).toBe(true)
    expect(await f.coordinator.getPolicy()).toBeNull()
    expect((await f.coordinator.status()).configured).toBe(false)
    await f.coordinator.configure(policy, null)
    expect(await f.coordinator.status()).toMatchObject({
      configured: true,
      online: false,
    })
  })

  it('requires full horizon expiry for explicit review and never restores stale permits', async () => {
    const f = fixture()
    await f.start()
    await f.coordinator.result(hash, { kind: 'error', id, error: 'timeout' })
    expect(await f.coordinator.review()).toBe(false)
    f.setNow(24999)
    expect(await f.coordinator.review()).toBe(false)
    f.setNow(25000)
    expect(await f.coordinator.review()).toBe(true)
    expect(await f.coordinator.status()).toMatchObject({
      active: false,
      blocked: false,
    })
    expect(await f.coordinator.getReviewResult()).toEqual({
      kind: 'error',
      id,
      error: 'timeout',
    })
    expect(await f.coordinator.confirmStart(hash, id)).toBeNull()
    expect(await f.coordinator.take(hash)).toBeNull()
    expect(
      await f.recreate().enqueue({
        ...f.task,
        id: otherId,
        dispatchBefore: 29000,
        expiresAt: 49000,
      }),
    ).toBe(true)
  })

  it('refuses review while a retired completed task is within its possible horizon', async () => {
    const f = fixture()
    await f.start()
    await f.coordinator.result(hash, response(403))
    await f.coordinator.consumeResult(id)
    expect(await f.coordinator.review()).toBe(false)
    f.setNow(25000)
    expect(await f.coordinator.review()).toBe(true)
    expect(await f.coordinator.getReviewResult()).toEqual(response(403))
  })

  it('retains missing results on review and latches a newly arriving error again', async () => {
    const f = fixture()
    await f.start()
    f.setNow(25000)
    expect(await f.coordinator.review()).toBe(true)
    expect(await f.coordinator.readResult(id)).toBeNull()
    expect(
      await f
        .recreate()
        .result(hash, { kind: 'error', id, error: 'interrupted' }),
    ).toBe(true)
    expect((await f.coordinator.status()).blocked).toBe(true)
  })

  it('validates stored state and external inputs rather than asserting their types', async () => {
    const f = fixture()
    await expect(
      f.coordinator.configure(policy, 'not-a-hash'),
    ).rejects.toThrow()
    expect(f.stored()).toBeUndefined()
    await f.start()
    await expect(
      f.coordinator.result(hash, { ...response(), id: 'invalid' }),
    ).rejects.toThrow()
    f.replaceStored({
      policy,
      tokenHash: hash,
      lastSeenAt: 1000,
      blocked: false,
      active: 'invalid',
      retired: null,
    })
    await expect(f.recreate().status()).rejects.toThrow()
  })

  it('fails closed on an expiry storage failure and recovers the serialization queue', async () => {
    const f = fixture()
    await f.start()
    f.setNow(25000)
    vi.mocked(f.dependencies.storage.save).mockRejectedValueOnce(
      new Error('Storage unavailable'),
    )
    await expect(f.coordinator.status()).rejects.toThrow('Storage unavailable')
    expect(await f.coordinator.status()).toMatchObject({
      blocked: true,
      active: true,
    })
  })
})
