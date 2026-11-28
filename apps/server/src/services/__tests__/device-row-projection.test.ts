import { describe, expect, it } from 'vitest'
import {
  compareCodePoints,
  isJsonObject,
  toJson,
} from '../device-rows/projection'

describe('device row projection helpers', () => {
  it('orders by code point, not by UTF-16 unit', () => {
    // U+FF61 sorts before U+1F600 by code point, after it by UTF-16 unit.
    const values = ['\u{1F600}', '｡', 'b', 'B', 'a']
    expect([...values].sort(compareCodePoints)).toEqual([
      'B',
      'a',
      'b',
      '｡',
      '\u{1F600}',
    ])
    expect(['\u{1F600}', '｡'].sort()).toEqual(['\u{1F600}', '｡'])
  })

  it('sends values as JSON, without undefined members', () => {
    expect(toJson({ a: 1, b: undefined, c: [null, 'x'] })).toEqual({
      a: 1,
      c: [null, 'x'],
    })
    expect(isJsonObject(toJson({ a: 1 }))).toBe(true)
    expect(isJsonObject(toJson([1]))).toBe(false)
    expect(isJsonObject(null)).toBe(false)
  })
})
