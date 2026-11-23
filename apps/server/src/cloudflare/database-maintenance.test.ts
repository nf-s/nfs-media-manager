import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  runDatabaseMaintenance,
  runRecordingOrderMaintenance,
} from './database-maintenance'

const {
  execute,
  log,
  refreshDuplicates,
  refreshFacets,
  refreshAlbumFacets,
  refreshOrder,
} = vi.hoisted(() => ({
  execute: vi.fn(),
  log: vi.fn(),
  refreshDuplicates: vi.fn(),
  refreshFacets: vi.fn(),
  refreshAlbumFacets: vi.fn(),
  refreshOrder: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ db: { execute } }))
vi.mock('@/lib/request-log', () => ({ writeRequestLog: log }))
vi.mock('@/services/browse', () => ({
  refreshTrackFacetVocabularyForMaintenance: refreshFacets,
  refreshAlbumFacetVocabularyForMaintenance: refreshAlbumFacets,
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
      refreshAlbumFacets.mockResolvedValue(published)
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
          event: 'database.album-facet-maintenance',
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
    expect(refreshAlbumFacets).toHaveBeenCalledOnce()
    expect(refreshOrder).toHaveBeenCalledOnce()
    expect(refreshDuplicates).toHaveBeenCalledOnce()
    expect(log.mock.calls.map(([event]) => event)).toEqual([
      {
        event: 'database.facet-maintenance',
        outcome: 'skipped',
        durationMs: expect.any(Number),
      },
      {
        event: 'database.album-facet-maintenance',
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
    expect(refreshAlbumFacets).not.toHaveBeenCalled()
    expect(refreshOrder).not.toHaveBeenCalled()
    expect(refreshDuplicates).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledExactlyOnceWith({
      event: 'database.probe',
      outcome: 'failed',
      durationMs: expect.any(Number),
    })
  })

  it('finishes each scheduled rebuild before starting the next one', async () => {
    const steps: string[] = []
    for (const { name, refresh } of [
      { name: 'facets', refresh: refreshFacets },
      { name: 'album facets', refresh: refreshAlbumFacets },
      { name: 'recording order', refresh: refreshOrder },
      { name: 'duplicates', refresh: refreshDuplicates },
    ]) {
      refresh.mockImplementation(async () => {
        steps.push(`start ${name}`)
        await Promise.resolve()
        steps.push(`finish ${name}`)
        return true
      })
    }

    await runDatabaseMaintenance(dailyTick + 5 * 60_000)

    expect(steps).toEqual([
      'start facets',
      'finish facets',
      'start album facets',
      'finish album facets',
      'start recording order',
      'finish recording order',
      'start duplicates',
      'finish duplicates',
    ])
  })

  it('distinguishes refresh failure from a successful connection', async () => {
    const failure = new Error('fixture refresh failure')
    refreshFacets.mockRejectedValue(failure)
    refreshOrder.mockResolvedValue(true)
    refreshDuplicates.mockRejectedValue(new Error('fixture duplicate failure'))
    await expect(runDatabaseMaintenance(dailyTick)).rejects.toBe(failure)
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
    expect(log).toHaveBeenCalledWith({
      event: 'database.duplicate-maintenance',
      outcome: 'failed',
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
