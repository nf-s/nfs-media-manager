import { describe, expect, it } from 'vitest'
import type { JsonValue } from '@repo/schemas/common'
import {
  canonicalJson,
  deviceRowHash,
  groupDeviceMarks,
  withExpandedIds,
} from './device-feed-batch'

describe('device row hash', () => {
  it('ignores key order at every depth', () => {
    const payload = { b: 1, a: { d: [1, { f: null, e: 'x' }], c: true } }
    const reordered = { a: { c: true, d: [1, { e: 'x', f: null }] }, b: 1 }
    expect(canonicalJson(payload)).toBe(
      '{"a":{"c":true,"d":[1,{"e":"x","f":null}]},"b":1}',
    )
    expect(deviceRowHash(reordered)).toBe(deviceRowHash(payload))
  })

  it('distinguishes array order, values and types', () => {
    const payloads: JsonValue[] = [
      { plays: [1, 2] },
      { plays: [2, 1] },
      { plays: ['1', '2'] },
      { plays: [1, 2], extra: null },
      { plays: null },
    ]
    const hashes = payloads.map(deviceRowHash)
    expect(new Set(hashes).size).toBe(hashes.length)
    expect(deviceRowHash('text')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('device mark batches', () => {
  it('reads each ID once per entity and keeps every key', () => {
    expect(
      groupDeviceMarks([
        { key: 4, entity: 'track', id: 'track-2' },
        { key: 5, entity: 'album', id: 'album-1' },
        { key: 6, entity: 'track', id: 'track-1' },
        { key: 7, entity: 'track', id: 'track-2' },
        { key: 8, entity: 'subscription', id: 'item-1' },
      ]),
    ).toEqual({
      entities: [
        { entity: 'track', ids: ['track-2', 'track-1'] },
        { entity: 'album', ids: ['album-1'] },
      ],
      keys: [4, 5, 6, 7, 8],
    })
    expect(groupDeviceMarks([])).toEqual({ entities: [], keys: [] })
  })

  it('adds expanded IDs after the marked ones without repeating any', () => {
    expect(
      withExpandedIds(
        ['track-2', 'track-1'],
        ['track-1', 'track-3', 'track-3'],
      ),
    ).toEqual(['track-2', 'track-1', 'track-3'])
  })
})
