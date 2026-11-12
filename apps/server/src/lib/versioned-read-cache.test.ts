import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVersionedReadCache } from './versioned-read-cache'

function fixture(
  options: { maxEntries?: number; maxValueBytes?: number } = {},
) {
  const readVersion = vi
    .fn<() => Promise<string | null>>()
    .mockResolvedValue('1:1:')
  const cache = createVersionedReadCache<string[]>({
    maxEntries: 2,
    maxValueBytes: 100,
    ttlMs: 30_000,
    ...options,
    readVersion,
  })
  const load = vi.fn(async () => ['value'])
  return { cache, readVersion, load }
}

afterEach(() => vi.useRealTimers())

describe('versioned read cache', () => {
  it('isolates pending reads and prevents callers mutating retained data', async () => {
    const { cache, load } = fixture()
    const results = await Promise.all([cache('a', load), cache('a', load)])
    results[0]?.push('changed')
    expect(await cache('a', load)).toEqual(['value'])
    expect(results[1]).toEqual(['value'])
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('validates every hit and expires without sliding the TTL', async () => {
    vi.useFakeTimers()
    const { cache, load, readVersion } = fixture()
    await cache('a', load)
    vi.advanceTimersByTime(29_999)
    await cache('a', load)
    expect(readVersion).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(1)
    await cache('a', load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('evicts least recently used entries within its capacity', async () => {
    const { cache, load } = fixture()
    await cache('a', load)
    await cache('b', load)
    await cache('a', load)
    await cache('c', load)
    await cache('a', load)
    expect(load).toHaveBeenCalledTimes(3)
    await cache('b', load)
    expect(load).toHaveBeenCalledTimes(4)
  })

  it('does not retain a load that crosses a commit', async () => {
    const { cache, load, readVersion } = fixture()
    readVersion.mockResolvedValueOnce('1:1:').mockResolvedValue('2:2:')
    await cache('a', load)
    await cache('a', load)
    await cache('a', load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('does not retain failures and propagates version-read failures', async () => {
    const { cache, load, readVersion } = fixture()
    load.mockRejectedValueOnce(new Error('query failed'))
    await expect(cache('a', load)).rejects.toThrow('query failed')
    await cache('a', load)
    expect(load).toHaveBeenCalledTimes(2)
    readVersion.mockRejectedValueOnce(new Error('database offline'))
    await expect(cache('a', load)).rejects.toThrow('database offline')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('bypasses retention for oversized values without truncating them', async () => {
    const { cache, load } = fixture({ maxValueBytes: 2 })
    expect(await cache('a', load)).toEqual(['value'])
    expect(await cache('a', load)).toEqual(['value'])
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('bypasses missing/oversized versions and oversized keys', async () => {
    const { cache, load, readVersion } = fixture()
    readVersion.mockResolvedValue(null)
    await cache('a', load)
    await cache('a', load)
    readVersion.mockResolvedValue('x'.repeat(8193))
    await cache('a', load)
    await cache('a', load)
    await cache('x'.repeat(16385), load)
    await cache('x'.repeat(16385), load)
    expect(load).toHaveBeenCalledTimes(6)
    expect(readVersion).toHaveBeenCalledTimes(4)
  })
})
