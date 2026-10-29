import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ProviderItemNotFoundError,
  ProviderRequestError,
  isProviderItemNotFoundError,
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
