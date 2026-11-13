import { describe, expect, it, vi } from 'vitest'
import {
  CLOUD_JOB_LEASE_MS,
  CloudJobCoordinator,
  type CloudJobCoordinatorDependencies,
  type CloudJobCoordinatorState,
} from '@/services/cloud-job-coordinator'
import type { CloudJobMessage } from '@/services/cloud-job-contract'

function fixture(concurrency = 2) {
  let state: CloudJobCoordinatorState | undefined
  let alarmAt: number | null = null
  let now = 1000
  let tokens = 0
  const records = new Map<string, string>(
    Array.from({ length: 40 }, (_, index) => [`job-${index}`, 'queued']),
  )
  const sent: CloudJobMessage[] = []
  const dependencies: CloudJobCoordinatorDependencies = {
    storage: {
      load: async () => structuredClone(state),
      save: async (next, alarm) => {
        state = structuredClone(next)
        alarmAt = alarm
      },
    },
    now: () => now,
    token: () => `token-${tokens++}`,
    send: vi.fn(async (message) => {
      sent.push(message)
    }),
    policy: vi.fn(async () => ({
      maxConcurrent: concurrency,
      blocked: false,
      wakeAt: null,
    })),
    queued: vi.fn(async (_provider, excluded, limit, allowed) =>
      [...records]
        .filter(
          ([id, status]) =>
            status === 'queued' &&
            !excluded.includes(id) &&
            (allowed == null || allowed.includes(id)),
        )
        .slice(0, limit)
        .map(([id]) => id),
    ),
    recover: vi.fn(async (jobId) => {
      if (records.get(jobId) === 'running') records.set(jobId, 'failed')
    }),
  }
  return {
    coordinator: new CloudJobCoordinator(dependencies),
    dependencies,
    records,
    sent,
    state: () => structuredClone(state),
    alarmAt: () => alarmAt,
    advance: (ms: number) => {
      now += ms
    },
    recreate: () => new CloudJobCoordinator(dependencies),
    message(index = 0) {
      const message = sent[index]
      if (!message) throw new Error('Expected a dispatched message')
      return message
    },
  }
}

describe('durable provider dispatch', () => {
  it('reads default and legacy status without saving or arming an alarm', async () => {
    const f = fixture()
    const save = vi.spyOn(f.dependencies.storage, 'save')
    expect(await f.coordinator.getStatus('fixture')).toEqual({
      provider: 'fixture',
      paused: true,
      allowedJobIds: null,
      stopped: false,
      failures: 0,
      infrastructureFailures: 0,
      slots: [],
    })
    f.dependencies.storage.load = async () => ({
      provider: 'fixture',
      paused: false,
      stopped: true,
      failures: 2,
      infrastructureFailures: 1,
      slots: [],
    })
    expect(await f.recreate().getStatus('fixture')).toMatchObject({
      paused: false,
      allowedJobIds: null,
      stopped: true,
      failures: 2,
      infrastructureFailures: 1,
    })
    expect(save).not.toHaveBeenCalled()
    expect(f.dependencies.policy).not.toHaveBeenCalled()
    expect(f.dependencies.queued).not.toHaveBeenCalled()
    expect(f.dependencies.recover).not.toHaveBeenCalled()
    expect(f.dependencies.send).not.toHaveBeenCalled()
    expect(f.alarmAt()).toBeNull()
    await expect(f.coordinator.getStatus('other')).rejects.toThrow(
      'identity mismatch',
    )
  })

  it('dispatches a provider that starts unpaused and keeps a later pause', async () => {
    const f = fixture(1)
    const initiallyPaused = vi.fn(async () => false)
    f.dependencies.initiallyPaused = initiallyPaused
    await f.coordinator.wake('fixture')
    expect(initiallyPaused).toHaveBeenCalledWith('fixture')
    expect(f.state()).toMatchObject({ paused: false, slots: [] })
    expect(f.alarmAt()).not.toBeNull()
    await f.coordinator.alarm()
    expect(f.sent).toHaveLength(1)

    expect(await f.coordinator.setPaused('fixture', true)).toBe(true)
    await f.recreate().wake('fixture')
    expect(f.state()).toMatchObject({ paused: true })
    expect(initiallyPaused).toHaveBeenCalledTimes(1)
  })

  it('preserves selection across pause, resume, wake and eviction', async () => {
    const f = fixture()
    await f.coordinator.setPaused('fixture', true, ['job-30'])
    await f.recreate().setPaused('fixture', false)
    await f.coordinator.wake('fixture')
    await f.recreate().alarm()
    await f.coordinator.setPaused('fixture', true)
    expect(await f.coordinator.begin(f.message())).toBe(false)
    await f.recreate().setPaused('fixture', false)
    expect(await f.coordinator.begin(f.message())).toBe(true)
    expect(f.state()?.allowedJobIds).toEqual(['job-30'])
    expect(f.sent.map((message) => message.jobId)).toEqual(['job-30'])
  })

  it('requires explicit null to release all jobs and treats an empty selection as deny-all', async () => {
    const f = fixture(1)
    await f.coordinator.setPaused('fixture', false, [])
    await f.coordinator.alarm()
    await f.recreate().setPaused('fixture', false)
    await f.coordinator.alarm()
    expect(f.sent).toEqual([])
    expect(f.state()?.allowedJobIds).toEqual([])
    await f.coordinator.setPaused('fixture', false, null)
    await f.recreate().alarm()
    expect(f.state()?.allowedJobIds).toBeNull()
    expect(f.message().jobId).toBe('job-0')
  })

  it.each(['offered', 'running'])(
    'rejects selection changes atomically with %s slots',
    async (phase) => {
      const f = fixture()
      await f.coordinator.setPaused('fixture', false, ['job-30', 'job-31'])
      await f.coordinator.alarm()
      if (phase === 'running') await f.coordinator.begin(f.message())
      const before = f.state()
      const alarmBefore = f.alarmAt()
      for (const selection of [null, [], ['job-0']]) {
        expect(await f.recreate().setPaused('fixture', true, selection)).toBe(
          false,
        )
        expect(f.state()).toEqual(before)
        expect(f.alarmAt()).toBe(alarmBefore)
      }
      expect(
        await f.coordinator.setPaused('fixture', true, ['job-31', 'job-30']),
      ).toBe(true)
      expect(f.state()?.paused).toBe(true)
    },
  )

  it('keeps canaries subject to provider cooldown after pause and resume', async () => {
    const f = fixture()
    f.dependencies.policy = vi.fn(async () => ({
      maxConcurrent: 2,
      blocked: true,
      wakeAt: 9000,
    }))
    await f.coordinator.setPaused('fixture', false, ['job-30'])
    await f.coordinator.alarm()
    expect(f.alarmAt()).toBe(9000)
    await f.coordinator.setPaused('fixture', true)
    await f.recreate().setPaused('fixture', false)
    await f.coordinator.alarm()
    expect(f.alarmAt()).toBe(9000)
    expect(f.dependencies.queued).not.toHaveBeenCalled()
    expect(f.sent).toEqual([])
    expect(f.state()?.allowedJobIds).toEqual(['job-30'])
    f.advance(8000)
    f.dependencies.policy = vi.fn(async () => ({
      maxConcurrent: 2,
      blocked: false,
      wakeAt: null,
    }))
    await f.recreate().alarm()
    expect(f.message().jobId).toBe('job-30')
  })

  it('does not substitute backlog for missing, cancelled or terminal selections', async () => {
    const f = fixture()
    f.records.set('job-30', 'cancelled')
    f.records.set('job-31', 'succeeded')
    f.records.set('job-32', 'failed')
    await f.coordinator.setPaused('fixture', false, [
      'missing',
      'job-30',
      'job-31',
      'job-32',
    ])
    await f.coordinator.alarm()
    await f.coordinator.wake('fixture')
    await f.recreate().alarm()
    expect(f.sent).toEqual([])
    expect(f.records.get('job-0')).toBe('queued')
  })

  it('re-offers only selected jobs after offer expiry and fences stale delivery', async () => {
    const f = fixture()
    await f.coordinator.setPaused('fixture', false, ['job-30'])
    await f.coordinator.alarm()
    const first = f.message()
    f.advance(60000)
    await f.recreate().alarm()
    expect(f.sent.map((message) => message.jobId)).toEqual(['job-30', 'job-30'])
    expect(await f.coordinator.begin(first)).toBe(false)
    expect(await f.coordinator.begin(f.message(1))).toBe(true)
  })

  it.each([
    Array.from({ length: 11 }, (_, index) => `job-${index}`),
    ['job-0', 'job-0'],
    [''],
    ['x'.repeat(201)],
  ])(
    'rejects invalid selections before changing state: %j',
    async (...jobIds) => {
      const f = fixture()
      await expect(
        f.coordinator.setPaused('fixture', false, jobIds),
      ).rejects.toThrow()
      expect(f.state()).toBeUndefined()
    },
  )

  it('accepts at most ten explicitly selected IDs even with spare capacity', async () => {
    const f = fixture(32)
    const jobIds = Array.from({ length: 10 }, (_, index) => `job-${index + 20}`)
    expect(await f.coordinator.setPaused('fixture', false, jobIds)).toBe(true)
    await f.coordinator.alarm()
    expect(f.sent.map((message) => message.jobId)).toEqual(jobIds)
    expect(f.dependencies.queued).toHaveBeenCalledWith(
      'fixture',
      [],
      32,
      jobIds,
    )
  })

  it('finishes a canary without releasing the retained backlog', async () => {
    const f = fixture(1)
    await f.coordinator.setPaused('fixture', false, ['job-30', 'job-31'])
    await f.coordinator.alarm()
    for (let index = 0; index < 2; index++) {
      const message = f.message(index)
      expect(message.jobId).toBe(`job-${30 + index}`)
      expect(await f.coordinator.begin(message)).toBe(true)
      f.records.set(message.jobId, 'succeeded')
      await f.coordinator.recordOutcome(message, 'success')
      await f.coordinator.finish(message)
      await f.recreate().alarm()
    }
    await f.coordinator.wake('fixture')
    await f.recreate().alarm()
    expect(f.sent).toHaveLength(2)
    expect(f.alarmAt()).toBeNull()
    expect(f.records.get('job-0')).toBe('queued')
    expect(f.state()).toMatchObject({
      allowedJobIds: ['job-30', 'job-31'],
      slots: [],
    })
  })

  it('is manually paused by default and does not poll an empty or paused provider', async () => {
    const f = fixture()
    await f.coordinator.wake('fixture')
    expect(f.alarmAt()).toBeNull()
    await f.coordinator.alarm()
    expect(f.sent).toHaveLength(0)
    expect(f.dependencies.policy).not.toHaveBeenCalled()
    f.records.clear()
    await f.coordinator.setPaused('fixture', false)
    expect(f.alarmAt()).toBe(1001)
    await f.coordinator.alarm()
    expect(f.alarmAt()).toBeNull()
  })

  it('persists capacity before sending and survives eviction without over-dispatch', async () => {
    const f = fixture(3)
    f.dependencies.send = vi.fn(async (message) => {
      expect(
        f.state()?.slots.some((slot) => slot.token === message.token),
      ).toBe(true)
      f.sent.push(message)
    })
    await f.coordinator.setPaused('fixture', false)
    await Promise.all([f.coordinator.alarm(), f.coordinator.alarm()])
    expect(f.sent).toHaveLength(3)
    const restored = f.recreate()
    await restored.alarm()
    expect(f.sent).toHaveLength(3)
    expect(await restored.begin(f.message())).toBe(true)
    expect(await restored.isActive(f.message())).toBe(true)
  })

  it('accepts only one concurrent delivery and never frees its slot on duplicate begin', async () => {
    const f = fixture(1)
    await f.coordinator.setPaused('fixture', false)
    await f.coordinator.alarm()
    expect(
      await Promise.all([
        f.coordinator.begin(f.message()),
        f.coordinator.begin(f.message()),
      ]),
    ).toEqual([true, false])
    await f.coordinator.alarm()
    expect(f.sent).toHaveLength(1)
    expect(f.state()?.slots).toHaveLength(1)
  })

  it('refills on completion and ignores stale completion tokens', async () => {
    const f = fixture(1)
    await f.coordinator.setPaused('fixture', false)
    await f.coordinator.alarm()
    const first = f.message()
    await f.coordinator.begin(first)
    f.records.set(first.jobId, 'succeeded')
    await f.coordinator.finish(first)
    expect(f.alarmAt()).toBe(1001)
    await f.coordinator.alarm()
    expect(f.sent).toHaveLength(2)
    await f.coordinator.finish(first)
    expect(f.state()?.slots[0]?.token).toBe(f.message(1).token)
  })

  it('re-offers unclaimed jobs with a new token, fencing late queue messages', async () => {
    const f = fixture(1)
    await f.coordinator.setPaused('fixture', false)
    await f.coordinator.alarm()
    const first = f.message()
    f.advance(60000)
    await f.recreate().alarm()
    expect(f.sent).toHaveLength(2)
    expect(f.message(1).jobId).toBe(first.jobId)
    expect(f.message(1).token).not.toBe(first.token)
    expect(await f.coordinator.begin(first)).toBe(false)
    expect(await f.coordinator.begin(f.message(1))).toBe(true)
  })

  it('fails interrupted running work without automatically retrying its provider', async () => {
    const f = fixture(1)
    await f.coordinator.setPaused('fixture', false)
    await f.coordinator.alarm()
    const first = f.message()
    await f.coordinator.begin(first)
    f.records.set(first.jobId, 'running')
    f.advance(CLOUD_JOB_LEASE_MS - 1)
    await f.coordinator.alarm()
    expect(f.dependencies.recover).not.toHaveBeenCalled()
    f.advance(1)
    await f.recreate().alarm()
    expect(f.records.get(first.jobId)).toBe('failed')
    expect(
      f.sent.filter((message) => message.jobId === first.jobId),
    ).toHaveLength(1)
    expect(await f.coordinator.isActive(first)).toBe(false)
  })

  it('retains cancelled in-flight capacity until finish or expiry', async () => {
    const f = fixture(1)
    await f.coordinator.setPaused('fixture', false)
    await f.coordinator.alarm()
    await f.coordinator.begin(f.message())
    f.records.set(f.message().jobId, 'cancelled')
    await f.coordinator.alarm()
    expect(f.sent).toHaveLength(1)
    await f.coordinator.finish(f.message())
    await f.coordinator.alarm()
    expect(f.sent).toHaveLength(2)
  })

  it('pauses new claims but permits already-running work to drain', async () => {
    const f = fixture()
    await f.coordinator.setPaused('fixture', false)
    await f.coordinator.alarm()
    await f.coordinator.begin(f.message())
    await f.coordinator.setPaused('fixture', true)
    expect(await f.coordinator.begin(f.message(1))).toBe(false)
    expect(await f.coordinator.isActive(f.message())).toBe(true)
    await f.coordinator.finish(f.message())
    f.advance(60000)
    await f.coordinator.alarm()
    expect(f.alarmAt()).toBeNull()
  })

  it('durably latches repeated failures and ignores duplicate outcomes and late successes', async () => {
    const f = fixture(3)
    await f.coordinator.setPaused('fixture', false)
    await f.coordinator.alarm()
    for (const message of f.sent) await f.coordinator.begin(message)
    await f.coordinator.recordOutcome(f.message(), 'failure')
    await f.coordinator.recordOutcome(f.message(), 'failure')
    expect(f.state()?.failures).toBe(1)
    const restored = f.recreate()
    await restored.recordOutcome(f.message(1), 'failure')
    await restored.recordOutcome(f.message(2), 'success')
    expect(f.state()?.stopped).toBe(true)
    expect(await restored.isActive(f.message(2))).toBe(false)
    await restored.setPaused('fixture', false)
    expect(f.state()?.stopped).toBe(true)
    await restored.alarm()
    expect(f.sent).toHaveLength(3)
  })

  it.each([false, true])(
    'keeps serial failures latched across empty slots and wakeups (benign miss between: %s)',
    async (includeBenignMiss) => {
      const f = fixture(1)
      await f.coordinator.setPaused('fixture', false)
      await f.coordinator.alarm()
      const outcomes = includeBenignMiss
        ? ['failure', 'benign', 'failure']
        : ['failure', 'failure']
      for (const [index, outcome] of outcomes.entries()) {
        const message = f.message(index)
        expect(await f.coordinator.begin(message)).toBe(true)
        if (outcome === 'failure')
          await f.coordinator.recordOutcome(message, 'failure')
        f.records.set(message.jobId, 'failed')
        await f.coordinator.finish(message)
        await f.recreate().alarm()
        expect(f.state()?.failures).toBe(index === outcomes.length - 1 ? 2 : 1)
      }
      expect(f.state()).toMatchObject({ stopped: true, slots: [] })
      expect(f.sent).toHaveLength(outcomes.length)
      expect(f.alarmAt()).toBeNull()

      const restored = f.recreate()
      await restored.wake('fixture')
      expect(f.alarmAt()).toBeNull()
      await restored.alarm()
      await restored.setPaused('fixture', true)
      expect(f.state()).toMatchObject({ stopped: true, failures: 2 })
      expect(f.sent).toHaveLength(outcomes.length)

      await restored.setPaused('fixture', false)
      expect(f.state()).toMatchObject({ stopped: false, failures: 0 })
      await restored.alarm()
      expect(f.sent).toHaveLength(outcomes.length + 1)
    },
  )

  it('clears a safety stop on an explicit restart once its slot is released, and keeps a pause', async () => {
    const f = fixture(1)
    await f.coordinator.setPaused('fixture', false)
    await f.coordinator.alarm()
    const message = f.message()
    await f.coordinator.begin(message)
    await f.coordinator.recordOutcome(message, 'stopped')

    await f.coordinator.resume('fixture')
    expect(f.state()?.stopped).toBe(true)

    f.records.set(message.jobId, 'failed')
    await f.coordinator.finish(message)
    await f.recreate().alarm()
    expect(f.sent).toHaveLength(1)

    await f.recreate().resume('fixture')
    expect(f.state()).toMatchObject({ stopped: false, failures: 0 })
    await f.coordinator.alarm()
    expect(f.sent).toHaveLength(2)

    const paused = fixture(1)
    await paused.coordinator.resume('fixture')
    expect(paused.state()).toMatchObject({ paused: true, stopped: false })
    expect(paused.alarmAt()).toBeNull()
  })

  it('resets consecutive serial failures on success without clearing a safety stop', async () => {
    const f = fixture(1)
    await f.coordinator.setPaused('fixture', false)
    await f.coordinator.alarm()
    const first = f.message()
    await f.coordinator.begin(first)
    await f.coordinator.recordOutcome(first, 'failure')
    f.records.set(first.jobId, 'failed')
    await f.coordinator.finish(first)
    await f.coordinator.alarm()
    expect(f.state()?.failures).toBe(1)

    const second = f.message(1)
    await f.coordinator.begin(second)
    await f.coordinator.recordOutcome(second, 'success')
    expect(f.state()).toMatchObject({ failures: 0, stopped: false })
    f.records.set(second.jobId, 'succeeded')
    await f.coordinator.finish(second)
    await f.coordinator.alarm()

    const third = f.message(2)
    await f.coordinator.begin(third)
    await f.coordinator.recordOutcome(third, 'stopped')
    f.records.set(third.jobId, 'failed')
    await f.coordinator.finish(third)
    await f.recreate().alarm()
    expect(f.state()).toMatchObject({ stopped: true, slots: [] })
    expect(f.sent).toHaveLength(3)
    expect(f.alarmAt()).toBeNull()
  })

  it('uses database callbacks only from alarms, never from control RPCs', async () => {
    const f = fixture(1)
    await f.coordinator.setPaused('fixture', false)
    await f.coordinator.alarm()
    vi.mocked(f.dependencies.policy).mockClear()
    vi.mocked(f.dependencies.queued).mockClear()
    vi.mocked(f.dependencies.recover).mockClear()

    const message = f.message()
    await f.coordinator.begin(message)
    expect(await f.coordinator.isActive(message)).toBe(true)
    await f.coordinator.recordOutcome(message, 'success')
    await f.coordinator.finish(message)
    await f.coordinator.wake('fixture')
    await f.coordinator.setPaused('fixture', true)
    await f.coordinator.setPaused('fixture', false)
    expect(f.dependencies.policy).not.toHaveBeenCalled()
    expect(f.dependencies.queued).not.toHaveBeenCalled()
    expect(f.dependencies.recover).not.toHaveBeenCalled()
  })

  it('schedules exact cooldown wakeups and leaves access halts dormant', async () => {
    const f = fixture()
    await f.coordinator.setPaused('fixture', false)
    f.dependencies.policy = vi.fn(async () => ({
      maxConcurrent: 2,
      blocked: true,
      wakeAt: 9000,
    }))
    await f.coordinator.alarm()
    expect(f.alarmAt()).toBe(9000)
    expect(f.dependencies.queued).not.toHaveBeenCalled()
    f.dependencies.policy = vi.fn(async () => ({
      maxConcurrent: 2,
      blocked: true,
      wakeAt: null,
    }))
    await f.coordinator.alarm()
    expect(f.alarmAt()).toBeNull()
  })

  it('retains an ambiguously published slot instead of sending its job again', async () => {
    const f = fixture(1)
    f.dependencies.send = vi.fn(async (message) => {
      f.sent.push(message)
      throw new Error('Queue transport unavailable after publication')
    })
    await f.coordinator.setPaused('fixture', false)
    await expect(f.coordinator.alarm()).rejects.toThrow('Queue transport')
    expect(f.state()?.slots).toHaveLength(1)
    expect(f.alarmAt()).toBe(3000)
    expect(await f.coordinator.begin(f.message())).toBe(true)
    await f.coordinator.alarm()
    expect(f.sent).toHaveLength(1)
  })

  it('backs off recovery outages and eventually requires manual intervention', async () => {
    const f = fixture(1)
    await f.coordinator.setPaused('fixture', false)
    await f.coordinator.alarm()
    f.advance(60000)
    f.dependencies.recover = vi.fn(async () => {
      throw new Error('Database unavailable')
    })
    for (let attempt = 0; attempt < 8; attempt++) {
      await expect(f.coordinator.alarm()).rejects.toThrow(
        'Database unavailable',
      )
      if (attempt < 7) expect(f.alarmAt()).toBeGreaterThan(61001)
    }
    expect(f.state()?.paused).toBe(true)
    expect(f.alarmAt()).toBeNull()
    await f.coordinator.alarm()
    expect(f.dependencies.recover).toHaveBeenCalledTimes(8)
  })

  it('bounds each dispatch and rejects provider identity mismatches', async () => {
    const f = fixture(100)
    await f.coordinator.setPaused('fixture', false)
    await f.coordinator.alarm()
    expect(f.sent).toHaveLength(32)
    await expect(f.coordinator.wake('another-provider')).rejects.toThrow(
      'identity mismatch',
    )
  })
})
