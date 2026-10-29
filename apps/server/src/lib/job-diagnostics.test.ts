import { describe, expect, it } from 'vitest'
import { JsonValueSchema } from '@repo/media-plugin-sdk'
import { createJobDiagnostics, sanitizeJobDiagnostic } from './job-diagnostics'

describe('bounded job diagnostics', () => {
  it.each(['lookup', 'serply.response'])(
    'redacts nested credential keys and resolved values without mutating input (%s)',
    (stage) => {
      const secret = 'fixture/key+value'
      const evidence = {
        response: {
          ApiKey: 'unknown-key',
          nested: [{ session_id: 'session-value' }],
        },
        headers: { 'X-Custom': 'opaque-header', Accept: 'application/json' },
        notes: [secret, encodeURIComponent(secret), `Bearer unlisted-token`],
        text: 'Cookie: first=one; second=two\nAuthorization: Basic opaque',
        url: 'https://user:pass@fixture.invalid/path?custom-credential=hidden#private',
        expectedYear: 2022,
      }
      const result = sanitizeJobDiagnostic({ stage, evidence }, [secret])
      expect(result).toMatchObject({
        stage,
        evidence: {
          response: {
            ApiKey: '[REDACTED]',
            nested: [{ session_id: '[REDACTED]' }],
          },
          headers: '[REDACTED]',
          url: 'https://fixture.invalid/path',
          expectedYear: 2022,
        },
      })
      const serialized = JSON.stringify(result)
      for (const value of [
        secret,
        encodeURIComponent(secret),
        'unknown-key',
        'session-value',
        'opaque-header',
        'unlisted-token',
        'first=one',
        'second=two',
        'opaque',
        'user:pass',
        'hidden',
        'private',
      ])
        expect(serialized).not.toContain(value)
      expect(evidence.headers['X-Custom']).toBe('opaque-header')
    },
  )

  it('redacts secrets in keys and embedded URLs, retaining only safe paths', () => {
    const result = sanitizeJobDiagnostic(
      {
        stage: 'lookup',
        evidence: {
          'the-hidden-value':
            'GET https://fixture.invalid/path?token=another-value and https://fixture.invalid/next?x=also-secret',
          'x-api-key': 'unlisted-value',
          credentials: { arbitrary: 'not-known-to-host' },
        },
      },
      ['hidden-value'],
    )
    const serialized = JSON.stringify(result)
    for (const value of [
      'hidden-value',
      'another-value',
      'also-secret',
      'unlisted-value',
      'not-known-to-host',
    ])
      expect(serialized).not.toContain(value)
    expect(serialized).toContain('https://fixture.invalid/path')
  })

  it('redacts URL-valued and numeric credentials before rewriting URLs or truncating text', () => {
    const secret = 'https://private.invalid/secret-path?key=secret-query'
    const result = sanitizeJobDiagnostic(
      {
        stage: 'lookup',
        evidence: {
          text: `before ${secret} after`,
          number: 12345,
          key: 'unlisted-key',
        },
      },
      [secret, '12345'],
    )
    expect(result).toMatchObject({
      evidence: {
        text: 'before [REDACTED] after',
        number: '[REDACTED]',
        key: '[REDACTED]',
      },
    })
  })

  it('validates untrusted envelopes and converts non-JSON leaves without invoking them', () => {
    for (const value of [
      null,
      [],
      {},
      { stage: '' },
      { stage: 'x' },
      { stage: 'x'.repeat(81), evidence: {} },
    ])
      expect(sanitizeJobDiagnostic(value, [])).toBeNull()
    const cyclic: Record<string, unknown> = { good: true }
    cyclic['self'] = cyclic
    const unsafe = Object.defineProperty({}, 'value', {
      get() {
        throw new Error('Must not read accessor')
      },
      enumerable: true,
    })
    const result = sanitizeJobDiagnostic(
      {
        stage: 'lookup',
        evidence: {
          cyclic,
          unsafe,
          bigint: 10n,
          date: new Date(),
          nan: NaN,
          infinity: Infinity,
          missing: undefined,
          callable: () => 'secret',
        },
      },
      [],
    )
    expect(result).toMatchObject({
      evidence: {
        cyclic: { good: true, self: '[circular]' },
        unsafe: { value: '[invalid-json]' },
        bigint: '[invalid-json]',
        date: '[invalid-json]',
        nan: '[invalid-json]',
        infinity: '[invalid-json]',
        missing: '[invalid-json]',
        callable: '[invalid-json]',
      },
    })
    expect(JsonValueSchema.safeParse(result).success).toBe(true)
  })

  it('caps depth, breadth, strings and UTF-8 bytes while retaining small evidence', () => {
    let deep: unknown = { final: 'never-retain' }
    for (let index = 0; index < 10000; index++) deep = { next: deep }
    const result = sanitizeJobDiagnostic(
      {
        stage: 'lookup',
        evidence: {
          reason: 'identity-mismatch',
          deep,
          many: Array.from({ length: 1000 }, (_, index) => ({
            index,
            text: '🎬'.repeat(1000),
          })),
          huge: 'x'.repeat(20000),
        },
      },
      [],
    )
    expect(result).toMatchObject({ evidence: { reason: 'identity-mismatch' } })
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192)
    expect(JSON.stringify(result)).not.toContain('never-retain')
    expect(JSON.stringify(result)).toContain('[truncated]')
    expect(JsonValueSchema.safeParse(result).success).toBe(true)
  })

  it('omits oversized strings rather than leaking a partially truncated credential', () => {
    const secret = 'secret'.repeat(4000)
    const result = sanitizeJobDiagnostic(
      { stage: 'lookup', evidence: { text: secret } },
      [secret],
    )
    expect(result).toMatchObject({
      evidence: { text: '[omitted oversized text]' },
    })
  })

  it('bounds the whole collection, snapshots by value and never throws on malformed input', () => {
    const collector = createJobDiagnostics(['fixture-secret'])
    collector.recordDiagnostic({
      stage: 'lookup',
      evidence: { reason: 'not-found' },
    })
    const first = collector.snapshot()
    first.length = 0
    expect(collector.snapshot()).toHaveLength(1)
    collector.recordDiagnostic(
      new Proxy(
        {},
        {
          get() {
            throw new Error('untrusted')
          },
        },
      ),
    )
    for (let index = 0; index < 30; index++)
      collector.recordDiagnostic({
        stage: 'lookup',
        evidence: Array(20).fill('🎬'.repeat(1000)),
      })
    const snapshot = collector.snapshot()
    expect(snapshot.length).toBeLessThanOrEqual(8)
    expect(snapshot.at(-1)).toEqual({
      stage: 'diagnostics.truncated',
      evidence: true,
    })
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(
      128 * 1024,
    )
    expect(JsonValueSchema.safeParse(snapshot).success).toBe(true)
  })

  it('caps many small diagnostics and sanitizes at recording rather than snapshot time', () => {
    const collector = createJobDiagnostics([])
    const evidence = { reason: 'before' }
    collector.recordDiagnostic({ stage: 'lookup', evidence })
    evidence.reason = 'after'
    for (let index = 0; index < 100; index++)
      collector.recordDiagnostic({ stage: 'lookup', evidence: index })
    expect(collector.snapshot()).toHaveLength(8)
    expect(collector.snapshot()[0]).toEqual({
      stage: 'lookup',
      evidence: { reason: 'before' },
    })
  })

  it('retains both response budgets alongside maximum candidate summaries', () => {
    const collector = createJobDiagnostics([])
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = sanitizeJobDiagnostic(
        {
          stage: 'serply.response',
          evidence: { attempt, response: Array(100).fill('x'.repeat(4096)) },
        },
        [],
      )
      expect(response).not.toBeNull()
      collector.recordDiagnostic(response)
      collector.recordDiagnostic({
        stage: 'serply.search',
        evidence: Array(20).fill('x'.repeat(512)),
      })
    }
    const snapshot = collector.snapshot()
    expect(snapshot).toHaveLength(4)
    expect(snapshot[0]).toMatchObject({
      stage: 'serply.response',
      evidence: { attempt: 0 },
    })
    expect(snapshot[2]).toMatchObject({
      stage: 'serply.response',
      evidence: { attempt: 1 },
    })
    expect(JSON.stringify(snapshot)).not.toContain('diagnostics.truncated')
    expect(JSON.stringify(snapshot)).toContain('[truncated]')
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeGreaterThan(
      64 * 1024,
    )
    for (let attempt = 0; attempt < 8; attempt++)
      collector.recordDiagnostic({
        stage: 'serply.response',
        evidence: Array(100).fill('x'.repeat(4096)),
      })
    expect(collector.snapshot().at(-1)).toEqual({
      stage: 'diagnostics.truncated',
      evidence: true,
    })
    expect(
      Buffer.byteLength(JSON.stringify(collector.snapshot())),
    ).toBeLessThanOrEqual(128 * 1024)
  })

  it('bounds response depth, breadth, UTF-8 strings and numeric data explicitly', () => {
    let deep: unknown = { final: 'never-retain' }
    for (let index = 0; index < 20; index++) deep = { next: deep }
    const result = sanitizeJobDiagnostic(
      {
        stage: 'serply.response',
        evidence: {
          deep,
          text: '🎬'.repeat(3000),
          many: Array.from({ length: 100 }, () =>
            Array(100).fill(Number.MAX_VALUE),
          ),
        },
      },
      [],
    )
    const serialized = JSON.stringify(result)
    expect(serialized).toContain('[truncated]')
    expect(serialized).not.toContain('never-retain')
    expect(serialized).not.toContain('[omitted oversized diagnostic]')
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(48 * 1024)
    expect(JsonValueSchema.safeParse(result).success).toBe(true)
  })
})
