import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runDatabaseMaintenance } from './database-maintenance'

const { execute, log, refresh } = vi.hoisted(() => ({
  execute: vi.fn(),
  log: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ db: { execute } }))
vi.mock('@/lib/request-log', () => ({ writeRequestLog: log }))
vi.mock('@/services/browse', () => ({
  refreshTrackFacetVocabularyForMaintenance: refresh,
}))

const dailyTick = Date.UTC(2026, 0, 1, 20, 0)
beforeEach(() => vi.resetAllMocks())

describe('scheduled database monitoring', () => {
  it.each([
    [true, 'published'],
    [false, 'skipped'],
  ])(
    'records a healthy probe and the maintenance result',
    async (published, outcome) => {
      refresh.mockResolvedValue(published)
      await runDatabaseMaintenance(dailyTick)
      expect(execute).toHaveBeenCalledOnce()
      expect(log.mock.calls.map(([event]) => event)).toEqual([
        {
          event: 'database.probe',
          outcome: 'ok',
          durationMs: expect.any(Number),
        },
        {
          event: 'database.facet-maintenance',
          outcome,
          durationMs: expect.any(Number),
        },
      ])
    },
  )

  it('runs ordinary maintenance between daily probes without the synthetic query', async () => {
    await runDatabaseMaintenance(dailyTick + 5 * 60_000)
    expect(execute).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledExactlyOnceWith({
      event: 'database.facet-maintenance',
      outcome: 'skipped',
      durationMs: expect.any(Number),
    })
  })

  it('records a failed probe without the database error contents', async () => {
    const failure = new Error('fixture connection failure')
    execute.mockRejectedValue(failure)
    await expect(runDatabaseMaintenance(dailyTick)).rejects.toBe(failure)
    expect(refresh).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledExactlyOnceWith({
      event: 'database.probe',
      outcome: 'failed',
      durationMs: expect.any(Number),
    })
  })

  it('distinguishes refresh failure from a successful connection', async () => {
    refresh.mockRejectedValue(new Error('fixture refresh failure'))
    await expect(runDatabaseMaintenance(dailyTick)).rejects.toThrow(
      'fixture refresh failure',
    )
    expect(log).toHaveBeenLastCalledWith({
      event: 'database.facet-maintenance',
      outcome: 'failed',
      durationMs: expect.any(Number),
    })
  })
})
