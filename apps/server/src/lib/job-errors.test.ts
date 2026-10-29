import { describe, expect, it } from 'vitest'
import { JobErrorDetailsSchema } from '@repo/schemas/job'
import {
  ProviderItemNotFoundError,
  ProviderRequestError,
  type MediaProviderPlugin,
} from '@repo/media-plugin-sdk'
import { jobErrorDetails, jobErrorReview, redactJobText } from './job-errors'

describe('job error diagnostics', () => {
  it('only permits typed lookup misses or exact plugin-declared legacy errors to be reviewed', () => {
    const plugin: MediaProviderPlugin = {
      manifest: {
        id: 'fixture',
        displayName: 'Fixture',
        description: '',
        mediaTypes: ['film'],
        secrets: [],
        rateLimit: { maxConcurrent: 1, minTimeMs: 1000 },
        reviewableErrors: [{ name: 'Error', message: 'No fixture match' }],
      },
    }
    expect(
      jobErrorReview(
        {
          error: jobErrorDetails(new ProviderItemNotFoundError('No match'), []),
          classification: 'not-found',
        },
        plugin,
      ).canMarkBenign,
    ).toBe(true)
    expect(
      jobErrorReview(
        { error: jobErrorDetails(new Error('No fixture match'), []) },
        plugin,
      ).canMarkBenign,
    ).toBe(true)
    for (const error of [
      new Error('Other failure'),
      new Error('No fixture match', {
        cause: new ProviderRequestError('Limited', 'rate-limit'),
      }),
      new ProviderRequestError('No fixture match', 'rate-limit'),
      new ProviderRequestError('Denied', 'access-denied'),
    ]) {
      expect(
        jobErrorReview({ error: jobErrorDetails(error, []) }, plugin)
          .canMarkBenign,
      ).toBe(false)
    }
    expect(
      jobErrorReview(
        { error: jobErrorDetails(new Error('No fixture match'), []) },
        null,
      ).canMarkBenign,
    ).toBe(false)
  })
  it('retains the original exception and nested cause stacks', () => {
    const cause = new TypeError('Invalid provider response')
    const error = new Error('Scrape failed', { cause })
    const details = JobErrorDetailsSchema.parse(jobErrorDetails(error, []))
    expect(details).toMatchObject({
      name: 'Error',
      message: 'Scrape failed',
      stack: error.stack,
    })
    expect(details.causes).toEqual([
      { name: 'TypeError', message: cause.message, stack: cause.stack },
    ])
  })
  it('redacts resolved credentials from messages and every stack, including URL-encoded values', () => {
    const secret = 'fixture/key+value'
    const error = new Error(`Failed with ${secret}`, {
      cause: new Error(
        `GET https://fixture.invalid?key=${encodeURIComponent(secret)}`,
      ),
    })
    const details = jobErrorDetails(error, [secret])
    expect(JSON.stringify(details)).not.toContain(secret)
    expect(JSON.stringify(details)).not.toContain(encodeURIComponent(secret))
    expect(details.stack).toContain('[REDACTED]')
    expect(details.causes[0]?.stack).toContain('[REDACTED]')
  })
  it('redacts common credential fields, URL passwords and authorization values', () => {
    const text =
      'GET https://user:password@fixture.invalid?api_key=one&token=two\n{"ApiKey":"three", "password": "four", "cookie": "session=five; other=six"}\nAuthorization: Bearer seven'
    const result = redactJobText(text, [])
    for (const secret of [
      'user:password',
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven',
    ])
      expect(result).not.toContain(secret)
    expect(result).toContain('https://[REDACTED]@fixture.invalid')
  })
  it('handles string/object throws and circular causes without inventing a stack', () => {
    expect(jobErrorDetails('plain failure', [])).toMatchObject({
      message: 'plain failure',
      stack: null,
    })
    expect(
      jobErrorDetails(
        { message: 'Response invalid', name: 'ProviderError' },
        [],
      ),
    ).toMatchObject({
      message: 'Response invalid',
      name: 'ProviderError',
      stack: null,
    })
    const error = new Error('Cycle')
    error.cause = error
    expect(jobErrorDetails(error, []).causes).toEqual([])
    expect(jobErrorDetails({ token: 'hidden' }, []).message).not.toContain(
      'hidden',
    )
  })
  it('bounds unusually large errors only after redaction', () => {
    const details = jobErrorDetails(new Error('x'.repeat(20000)), [])
    expect(details.message).toHaveLength(16012)
    expect(details.message).toContain('[truncated]')
  })
})
