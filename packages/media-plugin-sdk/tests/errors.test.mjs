import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ProviderItemNotFoundError,
  ProviderRequestError,
  isProviderItemNotFoundError,
  ProviderRequestDiagnosticsSchema,
} from '../dist/index.js'

describe('provider item miss identity', () => {
  it('recognizes domain errors from independently loaded SDK modules', async () => {
    const independent = await import('../dist/index.js?independent-sdk')
    const error = new independent.ProviderItemNotFoundError('No fixture match')

    assert.notEqual(
      independent.ProviderItemNotFoundError,
      ProviderItemNotFoundError,
    )
    assert.equal(error instanceof ProviderItemNotFoundError, false)
    assert.equal(isProviderItemNotFoundError(error), true)
    assert.equal(
      independent.isProviderItemNotFoundError(
        new ProviderItemNotFoundError('No fixture match'),
      ),
      true,
    )
  })

  it('does not classify messages, error names or serialized objects as domain errors', () => {
    const named = new Error('No fixture match')
    named.name = 'ProviderItemNotFoundError'
    const serialized = { name: named.name, message: named.message }
    const error = new ProviderItemNotFoundError('No fixture match')

    for (const value of [
      undefined,
      null,
      'No fixture match',
      new Error('No fixture match'),
      named,
      serialized,
      { ...error },
    ]) {
      assert.equal(isProviderItemNotFoundError(value), false)
    }
    assert.equal(isProviderItemNotFoundError(error), true)
  })

  it('never treats wrapped or chained failures as benign item misses', () => {
    const miss = new ProviderItemNotFoundError('No fixture match')
    for (const cause of [
      new Error('Network failure'),
      new ProviderRequestError('Quota exceeded', 'rate-limit'),
      miss,
      undefined,
    ]) {
      assert.equal(
        isProviderItemNotFoundError(new Error('Wrapper', { cause })),
        false,
      )
      assert.equal(
        isProviderItemNotFoundError(
          Object.assign(new ProviderItemNotFoundError('No fixture match'), {
            cause,
          }),
        ),
        false,
      )
    }
    assert.equal(
      isProviderItemNotFoundError(
        new AggregateError([miss], 'No fixture match'),
      ),
      false,
    )
    assert.equal(
      isProviderItemNotFoundError(
        Object.assign(new ProviderItemNotFoundError('No fixture match'), {
          errors: [miss],
        }),
      ),
      false,
    )
  })

  it('preserves request failures from local and independently loaded SDK modules', async () => {
    const independent = await import('../dist/index.js?independent-sdk')
    for (const code of [
      'rate-limit',
      'cooldown',
      'request-failed',
      'access-denied',
    ]) {
      for (const RequestError of [
        ProviderRequestError,
        independent.ProviderRequestError,
      ]) {
        assert.equal(
          isProviderItemNotFoundError(
            new RequestError('No fixture match', code),
          ),
          false,
        )
      }
    }
  })
})

describe('provider request diagnostics', () => {
  it('keeps the existing constructor and error cause compatible', () => {
    const cause = new Error('Fixture failure')
    const error = new ProviderRequestError(
      'Request failed',
      'request-failed',
      null,
      false,
      { cause },
    )
    assert.equal(error.cause, cause)
    assert.equal(error.diagnostics, undefined)
  })

  it('retains only validated diagnostic metadata alongside the original cause', () => {
    const cause = new Error('Fixture response')
    const diagnostics = {
      source: 'provider-response',
      httpStatus: 429,
      responseReceivedAt: '2026-01-01T00:00:00.000Z',
      quotaError: false,
      retryAfter: { seconds: 120 },
      quotaHeaders: { 'x-discogs-ratelimit-remaining': 0 },
    }
    const error = new ProviderRequestError(
      'Quota reached',
      'rate-limit',
      1767225720000,
      true,
      { cause, diagnostics },
    )
    assert.equal(error.cause, cause)
    assert.deepEqual(error.diagnostics, diagnostics)
    assert.deepEqual(
      ProviderRequestDiagnosticsSchema.parse(error.diagnostics),
      diagnostics,
    )
    assert.notEqual(error.diagnostics, diagnostics)
  })

  it('omits unsupported or malformed diagnostics without replacing the request failure', () => {
    for (const diagnostics of [
      {
        source: 'provider-response',
        requestUrl: 'https://fixture.invalid/private',
      },
      { source: 'provider-response', httpStatus: 999 },
      { source: 'provider-response', responseReceivedAt: 'invalid' },
      { source: 'provider-response', quotaHeaders: { authorization: 123 } },
      {
        source: 'provider-response',
        quotaHeaders: { 'x-discogs-ratelimit-remaining': -1 },
      },
      {
        source: 'provider-response',
        quotaHeaders: { 'x-discogs-ratelimit-used': 'not-a-number' },
      },
      { source: 'provider-response', retryAfter: { seconds: Infinity } },
      { source: 'provider-response', retryAfter: { at: 'arbitrary text' } },
      { source: 'unknown' },
      { source: 'local-cooldown', httpStatus: 429 },
      { source: 'local-budget', quotaHeaders: { 'x-ratelimit-limit': 1 } },
    ]) {
      const error = new ProviderRequestError(
        'Quota reached',
        'rate-limit',
        null,
        false,
        { diagnostics },
      )
      assert.equal(error.message, 'Quota reached')
      assert.equal(error.diagnostics, undefined)
    }
  })
})
