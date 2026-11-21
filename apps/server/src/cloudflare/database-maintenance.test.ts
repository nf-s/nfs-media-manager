import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  runDatabaseMaintenance,
  runRecordingOrderMaintenance,
} from './database-maintenance'

const { execute, log, refreshDuplicates, refreshFacets, refreshOrder } =
  vi.hoisted(() => ({
    execute: vi.fn(),
    log: vi.fn(),
    refreshDuplicates: vi.fn(),
    refreshFacets: vi.fn(),
    refreshOrder: vi.fn(),
  }))
vi.mock('@/lib/db', () => ({ db: { execute } }))
vi.mock('@/lib/request-log', () => ({ writeRequestLog: log }))
vi.mock('@/services/browse', () => ({
  refreshTrackFacetVocabularyForMaintenance: refreshFacets,
  refreshRecordingBrowseOrderForMaintenance: refreshOrder,
}))
vi.mock('@/services/track-duplicates', () => ({
  refreshTrackDuplicatesForMaintenance: refreshDuplicates,
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
      refreshFacets.mockResolvedValue(published)
      refreshOrder.mockResolvedValue(published)
      refreshDuplicates.mockResolvedValue(published)
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
        {
          event: 'database.recording-order-maintenance',
          source: 'scheduled',
          outcome,
          durationMs: expect.any(Number),
        },
        {
          event: 'database.duplicate-maintenance',
          outcome,
          durationMs: expect.any(Number),
        },
      ])
    },
  )

  it('runs ordinary maintenance between daily probes without the synthetic query', async () => {
    await runDatabaseMaintenance(dailyTick + 5 * 60_000)
    expect(execute).not.toHaveBeenCalled()
    expect(refreshFacets).toHaveBeenCalledOnce()
    expect(refreshOrder).toHaveBeenCalledOnce()
    expect(refreshDuplicates).toHaveBeenCalledOnce()
    expect(log.mock.calls.map(([event]) => event)).toEqual([
      {
        event: 'database.facet-maintenance',
        outcome: 'skipped',
        durationMs: expect.any(Number),
      },
      {
        event: 'database.recording-order-maintenance',
        source: 'scheduled',
        outcome: 'skipped',
        durationMs: expect.any(Number),
      },
      {
        event: 'database.duplicate-maintenance',
        outcome: 'skipped',
        durationMs: expect.any(Number),
      },
    ])
  })

  it('records a failed probe without the database error contents', async () => {
    const failure = new Error('fixture connection failure')
    execute.mockRejectedValue(failure)
    await expect(runDatabaseMaintenance(dailyTick)).rejects.toBe(failure)
    expect(refreshFacets).not.toHaveBeenCalled()
    expect(refreshOrder).not.toHaveBeenCalled()
    expect(refreshDuplicates).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledExactlyOnceWith({
      event: 'database.probe',
      outcome: 'failed',
      durationMs: expect.any(Number),
    })
  })

  it('distinguishes refresh failure from a successful connection', async () => {
    refreshFacets.mockRejectedValue(new Error('fixture refresh failure'))
    refreshOrder.mockResolvedValue(true)
    await expect(runDatabaseMaintenance(dailyTick)).rejects.toThrow(
      'fixture refresh failure',
    )
    expect(log).toHaveBeenCalledWith({
      event: 'database.facet-maintenance',
      outcome: 'failed',
      durationMs: expect.any(Number),
    })
    expect(log).toHaveBeenCalledWith({
      event: 'database.recording-order-maintenance',
      source: 'scheduled',
      outcome: 'published',
      durationMs: expect.any(Number),
    })
  })
})

it('refreshes only recording order for a Browse request', async () => {
  refreshOrder.mockResolvedValue(true)
  await runRecordingOrderMaintenance('browse')
  expect(execute).not.toHaveBeenCalled()
  expect(refreshFacets).not.toHaveBeenCalled()
  expect(refreshOrder).toHaveBeenCalledExactlyOnceWith('browse')
  expect(log).toHaveBeenCalledExactlyOnceWith({
    event: 'database.recording-order-maintenance',
    source: 'browse',
    outcome: 'published',
    durationMs: expect.any(Number),
  })
})
