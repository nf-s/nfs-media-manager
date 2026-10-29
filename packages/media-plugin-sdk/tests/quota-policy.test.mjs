import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PluginRateLimitSchema } from '../dist/index.js'

test('concurrency and fixed read/write windows survive manifest validation', () => {
  const policy = {
    maxConcurrent: 3,
    concurrentRequests: true,
    minTimeMs: 350,
    fixedWindow: { durationMs: 300000, reads: 1000, writes: 300 },
  }
  assert.deepEqual(PluginRateLimitSchema.parse(policy), policy)
  assert.equal(
    PluginRateLimitSchema.parse({ maxConcurrent: 5, minTimeMs: 200 })
      .concurrentRequests,
    undefined,
  )
  for (const field of ['durationMs', 'reads', 'writes']) {
    for (const value of [0, -1, 0.5, '1000']) {
      assert.equal(
        PluginRateLimitSchema.safeParse({
          ...policy,
          fixedWindow: { ...policy.fixedWindow, [field]: value },
        }).success,
        false,
      )
    }
  }
})

test('quota response header handling is an optional, validated opt-in', () => {
  const policy = { maxConcurrent: 1, minTimeMs: 2000 }
  assert.equal(
    PluginRateLimitSchema.parse(policy).respectRateLimitHeaders,
    undefined,
  )
  for (const enabled of [true, false]) {
    assert.equal(
      PluginRateLimitSchema.parse({
        ...policy,
        respectRateLimitHeaders: enabled,
      }).respectRateLimitHeaders,
      enabled,
    )
  }
  assert.equal(
    PluginRateLimitSchema.safeParse({
      ...policy,
      respectRateLimitHeaders: 'true',
    }).success,
    false,
  )
})

test('configurable budgets round-trip without changing provider hard limits', () => {
  const policy = { maxConcurrent: 1, minTimeMs: 2000 }
  for (const period of ['hour', 'day']) {
    const parsed = PluginRateLimitSchema.parse({
      ...policy,
      requestBudget: { period, limit: 1000 },
      configurableRequestBudget: true,
      respectRateLimitHeaders: true,
    })
    assert.deepEqual(parsed.requestBudget, { period, limit: 1000 })
    assert.equal(parsed.configurableRequestBudget, true)
    assert.equal(parsed.maxRequestsPerHour, undefined)
  }
  assert.equal(
    PluginRateLimitSchema.parse({ ...policy, maxRequestsPerHour: 140 })
      .maxRequestsPerHour,
    140,
  )
  for (const limit of [0, -1, 0.5, 100001]) {
    assert.equal(
      PluginRateLimitSchema.safeParse({
        ...policy,
        requestBudget: { period: 'day', limit },
      }).success,
      false,
    )
  }
})
