import { describe, expect, it } from 'vitest'
import { compareSnapshots } from './sample-statements'

function statement(fingerprint: string, values = {}) {
  return {
    fingerprint,
    topLevel: true,
    since: 1n,
    calls: 5n,
    executionMs: 20,
    sharedHits: 10n,
    sharedReads: 2n,
    tempReads: 0n,
    tempWrites: 3n,
    ...values,
  }
}

function snapshot(statements: ReturnType<typeof statement>[]) {
  return { started: 1n, reset: 2n, deallocations: 0n, statements }
}

describe('statement statistics sampling', () => {
  it('ranks deltas, separates nested statements and preserves the full integer range', () => {
    const largeCount = 9007199254740995n
    const before = snapshot([
      statement('-123', { calls: largeCount }),
      statement('-123', { topLevel: false }),
      statement('456'),
    ])
    const after = snapshot([
      statement('-123', {
        calls: largeCount + 2n,
        executionMs: 430,
        sharedHits: 12n,
      }),
      statement('-123', { topLevel: false, calls: 6n, executionMs: 23 }),
      statement('456'),
      statement('789', { since: 3n }),
    ])
    expect(compareSnapshots(before, after, 2)).toEqual({
      reset: false,
      evictionsObserved: false,
      statements: [
        {
          fingerprint: '-123',
          topLevel: true,
          calls: '2',
          executionMs: 410,
          sharedHits: '2',
          sharedReads: '0',
          tempReads: '0',
          tempWrites: '0',
        },
        {
          fingerprint: '789',
          topLevel: true,
          calls: '5',
          executionMs: 20,
          sharedHits: '10',
          sharedReads: '2',
          tempReads: '0',
          tempWrites: '3',
        },
      ],
    })
    expect(compareSnapshots(before, after, 3).statements[2]).toMatchObject({
      fingerprint: '-123',
      topLevel: false,
      calls: '1',
    })
  })

  it('drops replaced, missing and regressed rows without losing unaffected deltas', () => {
    const before = snapshot(['1', '2', '3', '4'].map((id) => statement(id)))
    const after = {
      ...snapshot([
        statement('1', { since: 3n, calls: 10n, executionMs: 40 }),
        statement('3', { calls: 6n, sharedHits: 1n }),
        statement('4', { calls: 6n, executionMs: 23 }),
      ]),
      deallocations: 1n,
    }
    const report = compareSnapshots(before, after, 20)
    expect(report.evictionsObserved).toBe(true)
    expect(report.statements).toHaveLength(1)
    expect(report.statements[0]?.fingerprint).toBe('4')
  })

  it('discards the entire interval after a global reset or restart', () => {
    const before = snapshot([])
    const after = snapshot([statement('1')])
    for (const changed of [{ reset: 3n }, { started: 3n }]) {
      expect(compareSnapshots(before, { ...after, ...changed }, 20)).toEqual({
        reset: true,
        evictionsObserved: false,
        statements: [],
      })
    }
  })
})
