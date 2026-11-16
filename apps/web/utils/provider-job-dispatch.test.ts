import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CloudDispatchStatusSchema } from '@repo/schemas/job'
import {
  createProviderDispatchInput,
  providerDispatchPollInterval,
} from './provider-job-dispatch'

test('dispatch status backs off without active slots, including paused and stopped queues', () => {
  const idle = CloudDispatchStatusSchema.parse({
    provider: 'fixture',
    paused: false,
    stopped: false,
    failures: 0,
    infrastructureFailures: 0,
    slots: [],
  })
  assert.equal(providerDispatchPollInterval(undefined), 30_000)
  assert.equal(providerDispatchPollInterval(null), 30_000)
  for (const status of [
    idle,
    { ...idle, paused: true },
    { ...idle, stopped: true },
  ]) {
    assert.equal(providerDispatchPollInterval(status), 30_000)
    assert.equal(
      providerDispatchPollInterval({
        ...status,
        slots: [{ jobId: 'fixture-job', phase: 'running', expiresAt: 1 }],
      }),
      3000,
    )
  }
})

test('resuming sends the exact reviewed selection even if the original state changes', () => {
  const status = { allowedJobIds: ['reviewed-job'] }
  const input = createProviderDispatchInput('resume', status)
  status.allowedJobIds.push('unreviewed-job')
  assert.deepEqual(input, { paused: false, jobIds: ['reviewed-job'] })
})

test('an empty reviewed selection never broadens to all queued jobs', () => {
  assert.deepEqual(
    createProviderDispatchInput('resume', { allowedJobIds: [] }),
    {
      paused: false,
      jobIds: [],
    },
  )
})

test('all-job scope is explicit while pausing leaves selection untouched', () => {
  const restricted = { allowedJobIds: ['reviewed-job'] }
  assert.deepEqual(createProviderDispatchInput('resume-all', restricted), {
    paused: false,
    jobIds: null,
  })
  assert.deepEqual(
    createProviderDispatchInput('resume', { allowedJobIds: null }),
    {
      paused: false,
      jobIds: null,
    },
  )
  assert.deepEqual(createProviderDispatchInput('pause', restricted), {
    paused: true,
  })
})
