import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CloudDispatchStatusSchema } from '@repo/schemas/job'
import { ProviderSummarySchema } from '@repo/schemas/provider'
import ProviderJobDispatch from './provider-job-dispatch'

const provider = ProviderSummarySchema.parse({
  id: 'fixture',
  displayName: 'Fixture provider',
  description: '',
  surface: 'provider',
  mediaTypes: ['film'],
  rateLimit: { maxConcurrent: 1, minTimeMs: 1000 },
  supportsScrape: true,
  supportsJobDispatchControl: true,
  supportsLegacyImport: false,
  secrets: [],
  pluginPath: null,
})
const stopped = CloudDispatchStatusSchema.parse({
  provider: 'fixture',
  paused: false,
  stopped: true,
  failures: 0,
  infrastructureFailures: 0,
  slots: [],
})

function render(data: unknown = stopped, configuration = provider) {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  })
  if (data !== undefined)
    client.setQueryData(['jobs', 'dispatch', 'fixture'], data)
  const network = mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network forbidden')
  })
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ProviderJobDispatch provider={configuration} />
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
    network.mock.restore()
  }
}

function button(html: string, text: string) {
  const value = [...html.matchAll(/<button\b[^>]*>.*?<\/button>/g)].find(
    ([markup]) => markup.includes(text),
  )?.[0]
  assert.ok(value, `Missing ${text} button`)
  return value
}

test('stopped queues expose restart without inventing a failure count', () => {
  const html = render()
  assert.match(html, /Queue stopped/)
  assert.match(html, /Resume queue/)
  assert.doesNotMatch(
    html,
    /disabled=""|Confirm|repeated failures|job failures/,
  )
})

test('pause, stop and restricted selection remain visible together', () => {
  const html = render({
    ...stopped,
    paused: true,
    allowedJobIds: ['previously-selected'],
  })
  assert.match(html, /Queue paused and stopped/)
  assert.match(html, /limited to 1 previously selected job/)
  assert.match(html, /Other queued jobs will wait/)
  assert.match(button(html, 'Resume selected jobs'), /<button/)
  assert.match(button(html, 'Resume all queued jobs'), /<button/)
  assert.doesNotMatch(html, /previously-selected|Pause queue|Confirm/)
})

test('active stopped work prevents restart or expanding a dispatch selection', () => {
  const html = render({
    ...stopped,
    allowedJobIds: ['previously-selected'],
    slots: [
      { jobId: 'active-job', phase: 'running', expiresAt: 1700000000000 },
    ],
  })
  assert.match(html, /1 active dispatch/)
  assert.match(html, /Waiting for active work to finish/)
  assert.match(button(html, 'Resume selected jobs'), /disabled=""/)
  assert.match(button(html, 'Resume all queued jobs'), /disabled=""/)
  assert.doesNotMatch(button(html, 'Pause queue'), /disabled=""/)
  assert.doesNotMatch(html, /active-job|expiresAt/)
})

test('queue errors and provider access blocks remain separate from queue state', () => {
  const html = render(
    { ...stopped, paused: true, infrastructureFailures: 8, failures: 2 },
    {
      ...provider,
      safety: {
        halted: true,
        cooldownUntil: null,
        consecutiveFailures: 2,
        requestsLastHour: 0,
        lastError: null,
      },
    },
  )
  assert.match(html, /2 job failures · 8 queue errors/)
  assert.match(html, /Provider access is blocked/)
  assert.match(html, /does not clear this block/)
})

test('unsupported runtimes hide dispatch controls and missing status is explicit', () => {
  assert.equal(
    render(stopped, { ...provider, supportsJobDispatchControl: false }),
    '',
  )
  const unavailable = render(null)
  assert.match(unavailable, /Queue status is unavailable/)
  assert.doesNotMatch(unavailable, /Resume|Restart|Pause/)
})

test('only an unexpired cooldown is shown as active', () => {
  function withCooldown(cooldownUntil: string) {
    return {
      ...provider,
      safety: {
        halted: false,
        cooldownUntil,
        consecutiveFailures: 0,
        requestsLastHour: 0,
        lastError: null,
      },
    }
  }
  assert.doesNotMatch(
    render(stopped, withCooldown(new Date(Date.now() - 60_000).toISOString())),
    /Provider cooldown until/,
  )
  assert.match(
    render(stopped, withCooldown(new Date(Date.now() + 60_000).toISOString())),
    /Provider cooldown until/,
  )
})
