import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProviderJobSummarySchema } from '@repo/schemas/provider'
import ProviderJobSummary from './provider-job-summary'

test('provider job summary includes every status and opens the provider jobs', () => {
  const summary = ProviderJobSummarySchema.parse({
    provider: 'fixture',
    total: 12,
    queued: 3,
    running: 1,
    succeeded: 5,
    failed: 2,
    cancelled: 1,
  })
  const html = renderToStaticMarkup(
    <ProviderJobSummary summary={summary} onOpenJobs={() => {}} />,
  )
  assert.match(html, /Jobs · 12/)
  for (const label of ['Queued', 'Running', 'Succeeded', 'Failed', 'Cancelled'])
    assert.match(html, new RegExp(`<dt[^>]*>${label}</dt>`))
  assert.match(html, />View jobs</)
})

test('providers without jobs show zero counts and omit the jobs action', () => {
  const html = renderToStaticMarkup(
    <ProviderJobSummary
      summary={{
        provider: 'fixture',
        total: 0,
        queued: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
      }}
      onOpenJobs={() => {}}
    />,
  )
  assert.match(html, /Jobs · 0/)
  assert.doesNotMatch(html, /View jobs/)
})
