import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProviderJobSummarySchema } from '@repo/schemas/provider'
import ProviderJobSummary from './provider-job-summary'

test('provider job summary shows the headline counts and opens the provider jobs', () => {
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
    <ProviderJobSummary
      summary={summary}
      jobsHref="/providers/fixture?tab=jobs"
    />,
  )
  assert.match(
    html,
    /<h3>Jobs<\/h3><span class="ds-muted">12 · 1 cancelled<\/span>/,
  )
  for (const [label, value] of [
    ['Queued', '3'],
    ['Running', '1'],
    ['Failed', '2'],
    ['Succeeded', '5'],
  ])
    assert.match(
      html,
      new RegExp(
        `<span class="ds-stat-value">${value}</span><span class="ds-stat-label">${label}</span>`,
      ),
    )
  assert.match(html, /data-tone="danger"><span class="ds-stat-value">2</)
  assert.match(html, /href="\/providers\/fixture\?tab=jobs"[^>]*>View jobs</)
  assert.match(
    html,
    /data-workspace-href="\/jobs\?provider=fixture&amp;status=failed"/,
  )
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
      jobsHref="/providers/fixture?tab=jobs"
    />,
  )
  assert.match(html, /<span class="ds-muted">0<\/span>/)
  assert.doesNotMatch(html, /View jobs|data-tone="danger"/)
})
