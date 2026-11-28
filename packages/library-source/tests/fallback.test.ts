import { describe, expect, it } from 'vitest'
import { TrackQuerySchema, type TrackQuery } from '@repo/schemas/tracks'
import {
  createFallbackLibrarySource,
  librarySourceFrom,
  type BrowseCount,
  type LibraryReadReport,
  type LibrarySource,
  type SourceResult,
} from '../src'

/** Synthetic answers only. */

const query = TrackQuerySchema.parse({ q: 'blue' })

/** A source that answers `trackCount` with `answer` (or rejects with it) and records each query. */
function countSource(answer: SourceResult<BrowseCount> | Error) {
  const calls: TrackQuery[] = []
  const source: LibrarySource = {
    ...librarySourceFrom(async (method) => {
      throw new Error(`Unexpected ${method}`)
    }),
    trackCount: async (read) => {
      calls.push(read)
      if (answer instanceof Error) throw answer
      return answer
    },
  }
  return { calls, source }
}

/** A clock that advances 5 ms each time it is read. */
function steppingClock() {
  let now = 100
  return () => {
    now += 5
    return now
  }
}

function recordReports() {
  const reports: LibraryReadReport[] = []
  return {
    reports,
    options: {
      onRead: (report: LibraryReadReport) => reports.push(report),
      now: steppingClock(),
    },
  }
}

describe('createFallbackLibrarySource', () => {
  it('answers from the device when it serves the read, without asking the API', async () => {
    const device = countSource({ served: true, data: { totalCount: 3 } })
    const remote = countSource({ served: true, data: { totalCount: 9 } })
    const { reports, options } = recordReports()
    const source = createFallbackLibrarySource(
      device.source,
      remote.source,
      options,
    )
    expect(await source.trackCount(query)).toStrictEqual({
      served: true,
      data: { totalCount: 3 },
    })
    expect(device.calls).toStrictEqual([query])
    expect(remote.calls).toStrictEqual([])
    expect(reports).toStrictEqual([
      { method: 'trackCount', source: 'device', durationMs: 5 },
    ])
  })

  it('asks the API when the device does not serve the read, and reports the reason', async () => {
    const device = countSource({ served: false, reason: 'provider-filter' })
    const remote = countSource({ served: true, data: { totalCount: 9 } })
    const { reports, options } = recordReports()
    const source = createFallbackLibrarySource(
      device.source,
      remote.source,
      options,
    )
    expect(await source.trackCount(query)).toStrictEqual({
      served: true,
      data: { totalCount: 9 },
    })
    expect(device.calls).toStrictEqual([query])
    expect(remote.calls).toStrictEqual([query])
    expect(reports).toStrictEqual([
      {
        method: 'trackCount',
        source: 'remote',
        reason: 'provider-filter',
        durationMs: 5,
      },
    ])
  })

  it('reports a store error and still falls through', async () => {
    const remote = countSource({ served: true, data: { totalCount: 2 } })
    const { reports, options } = recordReports()
    const source = createFallbackLibrarySource(
      countSource({ served: false, reason: 'store-error' }).source,
      remote.source,
      options,
    )
    expect(await source.trackCount(query)).toStrictEqual({
      served: true,
      data: { totalCount: 2 },
    })
    expect(remote.calls).toStrictEqual([query])
    expect(reports).toStrictEqual([
      {
        method: 'trackCount',
        source: 'remote',
        reason: 'store-error',
        durationMs: 5,
      },
    ])
  })

  it('treats a rejected device read as a store error', async () => {
    const { reports, options } = recordReports()
    const source = createFallbackLibrarySource(
      countSource(new Error('Storage unavailable')).source,
      countSource({ served: true, data: { totalCount: 2 } }).source,
      options,
    )
    expect(await source.trackCount(query)).toStrictEqual({
      served: true,
      data: { totalCount: 2 },
    })
    expect(reports).toStrictEqual([
      {
        method: 'trackCount',
        source: 'remote',
        reason: 'store-error',
        durationMs: 5,
      },
    ])
  })

  it('propagates an API error without a report', async () => {
    const failure = new Error('Request failed')
    const { reports, options } = recordReports()
    const source = createFallbackLibrarySource(
      countSource({ served: false, reason: 'not-ready' }).source,
      countSource(failure).source,
      options,
    )
    await expect(source.trackCount(query)).rejects.toBe(failure)
    expect(reports).toStrictEqual([])
  })

  it('passes each method and its query through unchanged, without options', async () => {
    const seen: unknown[] = []
    const device = librarySourceFrom(async () => ({
      served: false,
      reason: 'not-ready',
    }))
    const remote = librarySourceFrom(async (method, read) => {
      seen.push([method, read])
      return { served: false, reason: 'detail' }
    })
    const source = createFallbackLibrarySource(device, remote)
    expect(await source.fields('artist')).toStrictEqual({
      served: false,
      reason: 'detail',
    })
    await source.trackRecordings({ id: 'track-1', query })
    expect(seen).toStrictEqual([
      ['fields', 'artist'],
      ['trackRecordings', { id: 'track-1', query }],
    ])
  })
})
