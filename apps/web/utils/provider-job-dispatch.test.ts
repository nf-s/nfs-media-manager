import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProviderDispatchInput } from './provider-job-dispatch'

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
