import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { browsePageOptions, browseWindow } from './virtual-browse'

const geometry = {
  total: 10003,
  columns: 6,
  rowHeight: 300,
  scrollTop: 0,
  viewportHeight: 900,
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10))

test('full height comes from total, not loaded pages; DOM stays viewport bounded', () => {
  const start = browseWindow(geometry)
  const distant = browseWindow({ ...geometry, scrollTop: 360000 })
  assert.equal(start.height, Math.ceil(geometry.total / 6) * 300)
  assert.equal(distant.height, start.height)
  assert.ok(distant.end - distant.start <= 12 * 6)
  assert.ok(distant.start > 7000)
  assert.deepEqual(distant.pages, [72, 73])
  assert.ok(distant.pages.every((page) => page > 70))
})

test('zero results and last partial grid row never invent items', () => {
  const empty = browseWindow({ ...geometry, total: 0 })
  assert.equal(empty.height, 0)
  assert.equal(empty.end, 0)
  assert.deepEqual(empty.pages, [])
  const last = browseWindow({ ...geometry, scrollTop: 9999999 })
  assert.equal(last.end, 10003)
  assert.equal(last.padBottom, 0)
  assert.equal(last.pages.at(-1), 101)
})

test('table offsets include the sticky header, and rows fill the entire extent', () => {
  const table = browseWindow({
    ...geometry,
    columns: 1,
    rowHeight: 36,
    headerHeight: 34,
    scrollTop: 3634,
  })
  assert.equal(table.start, 96)
  assert.equal(table.height, 10003 * 36)
  assert.equal(
    table.padTop + (table.end - table.start) * 36 + table.padBottom,
    table.height,
  )
})

test('responsive columns recalculate the total height and bound visible slots', () => {
  for (const columns of [2, 5, 10]) {
    const window = browseWindow({ ...geometry, columns, scrollTop: 9000 })
    assert.equal(window.height, Math.ceil(geometry.total / columns) * 300)
    assert.ok(window.end - window.start <= 12 * columns)
    assert.equal(window.start % columns, 0)
  }
})

test('overlapping page observers deduplicate requests', async () => {
  const client = new QueryClient()
  let calls = 0
  let complete: (value: string) => void = () => {
    throw new Error('Not started')
  }
  const load = () => {
    calls++
    return new Promise<string>((resolve) => {
      complete = resolve
    })
  }
  const options = browsePageOptions('films', 'filters', 50, load)
  const a = new QueryObserver(client, options)
  const b = new QueryObserver(client, options)
  const stopA = a.subscribe(() => {})
  const stopB = b.subscribe(() => {})
  assert.equal(calls, 1)
  complete('page50')
  await settle()
  assert.equal(a.getCurrentResult().data, 'page50')
  assert.equal(b.getCurrentResult().data, 'page50')
  stopA()
  stopB()
  client.clear()
})

test('rapid scroll cancels distant requests, stale responses cannot replace new filters', async () => {
  const client = new QueryClient()
  const signals: AbortSignal[] = []
  const finish: ((value: string) => void)[] = []
  const load = (_page: number, signal: AbortSignal) => {
    signals.push(signal)
    return new Promise<string>((resolve) => {
      finish.push(resolve)
    })
  }
  const observer = new QueryObserver(
    client,
    browsePageOptions('films', 'old', 2, load),
  )
  const stop = observer.subscribe(() => {})
  observer.setOptions(browsePageOptions('films', 'old', 90, load))
  observer.setOptions(browsePageOptions('films', 'new-filter', 1, load))
  assert.equal(signals[0]?.aborted, true)
  assert.equal(signals[1]?.aborted, true)
  finish[2]?.('new-filter')
  await settle()
  finish[0]?.('stale page2')
  finish[1]?.('stale page90')
  await settle()
  assert.equal(observer.getCurrentResult().data, 'new-filter')
  assert.equal(client.getQueryCache().getAll().length, 1)
  stop()
  client.clear()
})

test('visiting many pages keeps only the first page and current window cached', async () => {
  const client = new QueryClient()
  const load = async (page: number) => page
  const first = new QueryObserver(
    client,
    browsePageOptions('films', 'sort', 1, load),
  )
  const stopFirst = first.subscribe(() => {})
  const window = new QueryObserver(
    client,
    browsePageOptions('films', 'sort', 2, load),
  )
  const stopWindow = window.subscribe(() => {})
  for (const page of [2, 30, 60, 100, 70, 5]) {
    window.setOptions(browsePageOptions('films', 'sort', page, load))
    await settle()
    assert.ok(client.getQueryCache().getAll().length <= 2)
    assert.equal(window.getCurrentResult().data, page)
  }
  stopFirst()
  stopWindow()
  await settle()
  assert.equal(client.getQueryCache().getAll().length, 0)
  client.clear()
})

test('page errors do not auto-loop; explicit retry recovers', async () => {
  const client = new QueryClient()
  let calls = 0
  const load = async () => {
    calls++
    if (calls === 1) throw new Error('Fixture failure')
    return 'recovered'
  }
  const observer = new QueryObserver(
    client,
    browsePageOptions('albums', 'sort', 4, load),
  )
  const stop = observer.subscribe(() => {})
  await settle()
  assert.equal(observer.getCurrentResult().isError, true)
  assert.equal(calls, 1)
  await observer.refetch()
  assert.equal(observer.getCurrentResult().data, 'recovered')
  stop()
  client.clear()
})
