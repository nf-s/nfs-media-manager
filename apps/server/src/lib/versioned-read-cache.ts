type CacheOptions = {
  maxEntries: number
  maxValueBytes: number
  ttlMs: number
  readVersion: () => Promise<string | null>
}

type Entry<T> = {
  version: string
  expiresAt: number
  value: T
}

// For JSON-compatible read models only. Retain resolved values, never I/O
// promises: Worker invocations cannot share each other's pending database work.
export function createVersionedReadCache<T>(options: CacheOptions) {
  const entries = new Map<string, Entry<T>>()
  const encoder = new TextEncoder()
  return async (key: string, load: () => Promise<T>): Promise<T> => {
    if (encoder.encode(key).byteLength > 16_384) return load()
    const version = await options.readVersion()
    if (version === null || encoder.encode(version).byteLength > 8_192)
      return load()
    const now = Date.now()
    for (const [key, entry] of entries)
      if (entry.expiresAt <= now) entries.delete(key)
    const cached = entries.get(key)
    if (cached?.version === version) {
      entries.delete(key)
      entries.set(key, cached)
      return structuredClone(cached.value)
    }
    entries.delete(key)
    const value = await load()
    const serialized = JSON.stringify(value)
    if (
      serialized === undefined ||
      encoder.encode(serialized).byteLength > options.maxValueBytes ||
      // Do not publish a result read across a concurrent commit.
      (await options.readVersion()) !== version ||
      Date.now() >= now + options.ttlMs
    )
      return value
    while (entries.size >= options.maxEntries) {
      const oldest = entries.keys().next()
      if (oldest.done) break
      entries.delete(oldest.value)
    }
    entries.set(key, {
      version,
      expiresAt: now + options.ttlMs,
      value: structuredClone(value),
    })
    return value
  }
}
