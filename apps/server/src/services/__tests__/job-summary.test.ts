import { describe, expect, it, vi } from 'vitest'
import type { MediaProviderPlugin } from '@repo/media-plugin-sdk'
import type { Job } from '@repo/schemas/job'
import type { ProviderWaiting } from '@repo/schemas/provider'
import { summarizeJob } from '@/services/job-summary'
import {
  firstWaiting,
  jobWaiting,
  providerTurn,
  type ProviderWaitState,
} from '@/services/job-waiting'

vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/services/provider-connections', () => ({
  hasAccountSignIn: (provider: string) => provider === 'fixture-account',
}))

const now = Date.parse('2026-11-16T13:00:00.000Z')
const plugin: MediaProviderPlugin = {
  manifest: {
    id: 'fixture-ratings',
    displayName: 'Fixture ratings',
    description: '',
    mediaTypes: ['album'],
    secrets: [],
    rateLimit: { maxConcurrent: 1, minTimeMs: 1000 },
  },
}

function state(overrides: Partial<ProviderWaitState> = {}): ProviderWaitState {
  return {
    provider: 'fixture-ratings',
    plugin,
    now,
    block: null,
    halted: false,
    cooldownUntil: null,
    running: 0,
    concurrency: 1,
    nextAllowedAt: null,
    budget: null,
    dispatch: null,
    ...overrides,
  }
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    provider: 'fixture-ratings',
    status: 'failed',
    createdAt: '2026-11-16T12:00:00.000Z',
    startedAt: '2026-11-16T12:00:01.000Z',
    finishedAt: '2026-11-16T12:00:02.000Z',
    errorMessage: 'Error: Stored failure',
    scope: { mediaItemIds: ['album-1'], mediaType: 'album', limit: 1 },
    options: {},
    confirmBroadRun: false,
    items: [
      {
        id: 'item-1',
        mediaItemId: 'album-1',
        mediaTitle: 'Harbour Lights',
        mediaType: 'album',
        provider: 'fixture-ratings',
        status: 'failed',
        attemptCount: 1,
        message: 'Error: Stored failure',
        createdAt: '2026-11-16T12:00:00.000Z',
        startedAt: '2026-11-16T12:00:01.000Z',
        finishedAt: '2026-11-16T12:00:02.000Z',
      },
    ],
    logs: [],
    ...overrides,
  }
}

function errorLog(
  error: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Job['logs'][number] {
  return {
    id: 'log-1',
    level: 'error',
    message: `${String(error.name)}: ${String(error.message)}`,
    metadata: {
      mediaItemId: 'album-1',
      error: { stack: null, causes: [], ...error },
      ...extra,
    },
    createdAt: '2026-11-16T12:00:02.000Z',
    canMarkBenign: false,
    benignReview: null,
  }
}

const cooling: ProviderWaiting = {
  reason: 'cooldown',
  until: '2026-11-16T14:20:00.000Z',
  detail: 'Cooling down: Provider rate limit reached (HTTP 429)',
}

describe('job summary', () => {
  it('leads a rate-limited failure with resuming the cooling provider', () => {
    expect(
      summarizeJob(
        job({
          errorMessage: 'ProviderRequestError: Provider rate limit reached',
          logs: [
            errorLog({
              name: 'ProviderRequestError',
              message: 'Provider rate limit reached (HTTP 429)',
              code: 'rate-limit',
              retryAt: Date.parse('2026-11-16T14:20:00.000Z'),
            }),
          ],
        }),
        state({
          block: cooling,
          cooldownUntil: Date.parse('2026-11-16T14:20:00.000Z'),
        }),
      ),
    ).toEqual({
      headline: 'The provider rate limited this request',
      code: 'rate-limit',
      retryAt: '2026-11-16T14:20:00.000Z',
      actions: ['resume-provider', 'open-provider'],
    })
  })

  it('offers a retry for a cooldown failure once the provider is free', () => {
    expect(
      summarizeJob(
        job({
          logs: [
            errorLog({
              name: 'ProviderRequestError',
              message: 'Provider cooldown is active',
              code: 'cooldown',
              retryAt: Date.parse('2026-11-16T12:30:00.000Z'),
            }),
          ],
        }),
        state(),
      ),
    ).toEqual({
      headline: 'The provider was cooling down',
      code: 'cooldown',
      retryAt: '2026-11-16T12:30:00.000Z',
      actions: ['retry', 'open-provider'],
    })
  })

  it('asks for credentials while access stays halted, and signs in for account tasks', () => {
    const denied = errorLog({
      name: 'ProviderRequestError',
      message: 'Provider request failed (HTTP 401)',
      code: 'access-denied',
    })
    expect(
      summarizeJob(job({ logs: [denied] }), state({ halted: true })),
    ).toEqual({
      headline: 'The provider denied access',
      code: 'access-denied',
      retryAt: null,
      actions: ['add-key'],
    })
    expect(
      summarizeJob(
        job({
          provider: 'fixture-account',
          options: { task: 'fixture-account-sync' },
          items: [],
          logs: [denied],
        }),
        state({ provider: 'fixture-account' }),
      ).actions,
    ).toEqual(['sign-in', 'retry'])
  })

  it('keeps the stored message for a failed request', () => {
    expect(
      summarizeJob(
        job({
          errorMessage:
            'ProviderRequestError: Provider request failed (HTTP 500)',
          logs: [
            errorLog({
              name: 'ProviderRequestError',
              message: 'Provider request failed (HTTP 500)',
              code: 'request-failed',
            }),
          ],
        }),
        state(),
      ),
    ).toEqual({
      headline: 'ProviderRequestError: Provider request failed (HTTP 500)',
      code: 'request-failed',
      retryAt: null,
      actions: ['retry', 'open-provider'],
    })
  })

  it('reads a code recorded on the cause', () => {
    expect(
      summarizeJob(
        job({
          logs: [
            errorLog({
              name: 'ProviderRequestError',
              message: 'Wrapped',
              causes: [
                {
                  name: 'ProviderRequestError',
                  message: 'Provider rate limit reached (HTTP 429)',
                  stack: null,
                  code: 'rate-limit',
                  retryAt: Date.parse('2026-11-16T12:10:00.000Z'),
                },
              ],
            }),
          ],
        }),
        state(),
      ),
    ).toMatchObject({
      code: 'rate-limit',
      retryAt: '2026-11-16T12:10:00.000Z',
    })
  })

  it.each([
    ['not-found', 'No matching item at the provider'],
    ['ambiguous', 'Several possible matches at the provider'],
  ])('offers to find a match for a %s lookup', (classification, headline) => {
    expect(
      summarizeJob(
        job({
          logs: [
            errorLog(
              {
                name: 'ProviderItemNotFoundError',
                message: 'Provider has no matching item (HTTP 404)',
              },
              { classification },
            ),
          ],
        }),
        state(),
      ),
    ).toEqual({
      headline,
      code: null,
      retryAt: null,
      actions: ['find-match', 'retry'],
    })
  })

  it('uses the stored message and only a retry for an unknown error', () => {
    expect(
      summarizeJob(
        job({
          logs: [errorLog({ name: 'Error', message: 'Stored failure' })],
        }),
        state(),
      ),
    ).toEqual({
      headline: 'Error: Stored failure',
      code: null,
      retryAt: null,
      actions: ['retry'],
    })
    expect(
      summarizeJob(
        job({ errorMessage: null, options: { retryJobId: 'job-2' } }),
        state(),
      ),
    ).toEqual({ headline: 'Failed', code: null, retryAt: null, actions: [] })
  })

  it('summarizes a cancelled, queued, running and succeeded job', () => {
    expect(
      summarizeJob(
        job({
          status: 'cancelled',
          errorMessage: null,
          logs: [
            {
              id: 'log-2',
              level: 'warn',
              message: 'Cancelled by the owner',
              metadata: null,
              createdAt: '2026-11-16T12:00:02.000Z',
              canMarkBenign: false,
              benignReview: null,
            },
          ],
        }),
        state(),
      ),
    ).toEqual({
      headline: 'Cancelled by the owner',
      code: null,
      retryAt: null,
      actions: ['retry'],
    })
    expect(
      summarizeJob(job({ status: 'queued' }), state({ block: cooling })),
    ).toEqual({
      headline: cooling.detail,
      code: null,
      retryAt: cooling.until,
      actions: ['resume-provider'],
    })
    expect(summarizeJob(job({ status: 'running' }), state()).headline).toBe(
      'Running',
    )
    expect(
      summarizeJob(
        job({
          status: 'succeeded',
          logs: [
            {
              id: 'log-3',
              level: 'info',
              message: '12 fields updated',
              metadata: null,
              createdAt: '2026-11-16T12:00:02.000Z',
              canMarkBenign: false,
              benignReview: null,
            },
          ],
        }),
        state(),
      ),
    ).toEqual({
      headline: '12 fields updated',
      code: null,
      retryAt: null,
      actions: [],
    })
  })
})

describe('job waiting', () => {
  it('reports a healthy provider as queued with its next request time', () => {
    expect(providerTurn(state())).toEqual({
      reason: 'queued',
      until: null,
      detail: 'Queued; nothing is blocking this provider',
    })
    expect(providerTurn(state({ nextAllowedAt: now + 1500 })).until).toBe(
      '2026-11-16T13:00:01.500Z',
    )
  })

  it('waits for running jobs when every slot is held', () => {
    expect(providerTurn(state({ running: 2, concurrency: 2 }))).toEqual({
      reason: 'concurrency',
      until: null,
      detail: 'Waiting for 2 running jobs',
    })
  })

  it('pauses jobs outside the dispatcher selection', () => {
    const selected = state({
      dispatch: {
        dispatch: {
          provider: 'fixture-ratings',
          paused: false,
          allowedJobIds: ['job-1'],
          stopped: false,
          failures: 0,
          infrastructureFailures: 0,
          slots: [],
        },
        worker: null,
      },
    })
    expect(jobWaiting(selected, 'job-1').reason).toBe('queued')
    expect(jobWaiting(selected, 'job-2')).toEqual({
      reason: 'paused',
      until: null,
      detail: 'Not in the jobs selected to run',
    })
  })

  it('prefers a free provider, then the block that lifts first', () => {
    const later = state({
      block: { ...cooling, until: '2026-11-16T15:00:00.000Z' },
    })
    const sooner = state({ block: cooling })
    const halted = state({
      block: { reason: 'access-denied', until: null, detail: 'Denied' },
    })
    expect(firstWaiting([halted, later, sooner])).toEqual(cooling)
    expect(firstWaiting([later, state()])?.reason).toBe('queued')
    expect(firstWaiting([])).toBeNull()
  })
})
