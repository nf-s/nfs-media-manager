import { describe, expect, it } from 'vitest'
import {
  HOUR_MS,
  hourlyBudget,
  retryAfterTime,
  responseQuota,
  rateLimitRetryAt,
  requestBudgetWindow,
  hasProviderQuotaError,
} from './request-policy'

describe('provider quota error bodies', () => {
  it.each([
    'dailyLimitExceeded',
    'rateLimitExceeded',
    'userRateLimitExceeded',
    'quotaExceeded',
  ])(
    'recognizes a validated nested %s reason without matching messages',
    (reason) => {
      const body = {
        error: {
          code: 403,
          errors: [{ reason, message: 'Untrusted details' }],
        },
      }
      expect(hasProviderQuotaError(body, false)).toBe(true)
      expect(hasProviderQuotaError(body, true)).toBe(true)
    },
  )
  it.each(
    [
      null,
      [],
      {},
      { error: { code: 403, errors: [{ reason: 'forbidden' }] } },
      {
        error: {
          code: 403,
          errors: [{ reason: 'dailyLimitExceededButDenied' }],
        },
      },
      { error: { code: 403, errors: [{ reason: 'DAILYLIMITEXCEEDED' }] } },
      { error: { code: '403', errors: [{ reason: 'dailyLimitExceeded' }] } },
      { error: { errors: [{ reason: 29 }] } },
      { error: { errors: [{ reason: 'dailyLimitExceeded' }, null] } },
      { error: { errors: 'dailyLimitExceeded' } },
      { error: { errors: [] } },
      { errors: [{ reason: 'dailyLimitExceeded' }] },
      { error: 'Quota access denied' },
      { message: 'Quota access denied' },
    ].map((body) => ({ body })),
  )('does not treat an unproven denial as a quota: $body', ({ body }) => {
    expect(hasProviderQuotaError(body, false)).toBe(false)
  })
  it.each(['Error', 'error', 'message', 'Message'])(
    'preserves successful-response %s message classification',
    (key) => {
      expect(
        hasProviderQuotaError({ [key]: 'Request limit reached!' }, true),
      ).toBe(true)
      expect(
        hasProviderQuotaError({ [key]: 'Invalid credentials' }, true),
      ).toBe(false)
      expect(
        hasProviderQuotaError({ [key]: 'Request limit reached!' }, false),
      ).toBe(false)
    },
  )
})

describe('request budgets', () => {
  it.each([
    { retry: '120', remaining: '9000', expectedSeconds: 120 },
    { retry: '120', remaining: '0', expectedSeconds: 7200 },
    { retry: '10800', remaining: '0', expectedSeconds: 10800 },
    { retry: null, remaining: '9000', expectedSeconds: 300 },
    { retry: 'invalid', remaining: '9000', expectedSeconds: 300 },
    { retry: '-1', remaining: '9000', expectedSeconds: 300 },
    { retry: null, remaining: '0', expectedSeconds: 7200 },
    {
      retry: 'Tue, 27 Oct 2026 13:02:00 GMT',
      remaining: '9000',
      expectedSeconds: 120,
    },
  ])(
    'uses authoritative Retry-After safely: $retry / remaining $remaining',
    ({ retry, remaining, expectedSeconds }) => {
      const now = Date.parse('2026-10-27T13:00:00Z')
      const headers = new Headers({
        'X-RateLimit-Limit': '10000',
        'X-RateLimit-Remaining': remaining,
        'X-RateLimit-Reset': String(now / 1000 + 7200),
      })
      if (retry !== null) headers.set('Retry-After', retry)
      expect(
        rateLimitRetryAt(
          headers,
          now,
          300000,
          responseQuota(headers, now),
          true,
        ),
      ).toBe(now + expectedSeconds * 1000)
    },
  )
  it('uses UTC midnight for daily budgets, including exact reset boundaries', () => {
    const now = Date.parse('2026-10-27T23:59:59.999Z')
    expect(requestBudgetWindow('day', now)).toEqual({
      from: Date.parse('2026-10-27T00:00:00Z'),
      resetsAt: Date.parse('2026-10-28T00:00:00Z'),
    })
    expect(requestBudgetWindow('day', now + 1)).toEqual({
      from: Date.parse('2026-10-28T00:00:00Z'),
      resetsAt: Date.parse('2026-10-29T00:00:00Z'),
    })
    expect(requestBudgetWindow('hour', now)).toEqual({
      from: now - HOUR_MS,
      resetsAt: now + HOUR_MS,
    })
  })
  it('reads exhausted quotas and Unix-second resets without assuming local midnight', () => {
    const now = Date.parse('2026-10-27T13:00:00Z')
    const resetAt = Date.parse('2026-10-28T00:00:00Z')
    expect(
      responseQuota(
        new Headers({
          'X-RateLimit-Limit': '1000',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(resetAt / 1000),
        }),
        now,
      ),
    ).toEqual({ exhausted: true, resetAt })
  })
  it.each([
    null,
    '',
    'bad',
    '-1',
    '1.5',
    '1e9',
    '9007199254740992',
    '9999999999999',
    '0',
    '1767225600',
  ])('ignores invalid or expired reset headers: %s', (reset) => {
    const headers = new Headers({
      'X-RateLimit-Limit': '1000',
      'X-RateLimit-Remaining': '0',
    })
    if (reset !== null) headers.set('X-RateLimit-Reset', reset)
    expect(responseQuota(headers, Date.parse('2026-10-27T00:00:00Z'))).toEqual({
      exhausted: false,
      resetAt: null,
    })
  })
  it.each([
    [null, '0'],
    ['', '0'],
    ['0', '0'],
    ['invalid', '0'],
    ['-1', '0'],
    ['1000', null],
    ['1000', ''],
    ['1000', '-1'],
    ['1000', '1'],
    ['1000', '1001'],
    ['1000', '0.0'],
    ['1000', 'invalid'],
  ])(
    'requires valid limit and exhausted remaining (%s, %s)',
    (limit, remaining) => {
      const resetAt = Date.parse('2026-10-28T00:00:00Z')
      const headers = new Headers({
        'X-RateLimit-Reset': String(resetAt / 1000),
      })
      if (limit !== null) headers.set('X-RateLimit-Limit', limit)
      if (remaining !== null) headers.set('X-RateLimit-Remaining', remaining)
      expect(responseQuota(headers, resetAt - 1000)).toEqual({
        exhausted: false,
        resetAt,
      })
    },
  )
  it('honors seconds, HTTP dates and conservative fallback cooldowns', () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(retryAfterTime('120', now, 60000)).toBe(now + 120000)
    expect(retryAfterTime('Thu, 01 Jan 2026 00:03:00 GMT', now, 60000)).toBe(
      now + 180000,
    )
    for (const header of [null, '', 'invalid', '-1', '1'])
      expect(retryAfterTime(header, now, 60000)).toBe(now + 60000)
  })
  it('uses a rolling hour and the oldest request even if timestamps are unordered', () => {
    const now = HOUR_MS + 100
    expect(hourlyBudget([100, 200, 300], now, 2)).toEqual({
      recent: [200, 300],
      retryAt: HOUR_MS + 200,
    })
    expect(hourlyBudget([300, 200], now, 2).retryAt).toBe(HOUR_MS + 200)
    expect(hourlyBudget([200], now, 2).retryAt).toBeNull()
  })
})
