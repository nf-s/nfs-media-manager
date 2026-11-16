import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CloudDispatchStatusSchema } from '@repo/schemas/job'
import {
  ProviderLocalWorkerStatusSchema,
  ProviderSummarySchema,
  type ProviderLocalWorkerStatus,
} from '@repo/schemas/provider'
import {
  ProviderDispatchActions,
  ProviderDispatchNotes,
  ProviderDispatchReview,
  ProviderWorkerModeSwitch,
  dispatchStateLabel,
  useProviderDispatch,
} from './provider-job-dispatch'
import { useProviderLocalWorkerMode } from './provider-local-worker'

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

function Dispatch({
  provider: configuration,
  worker,
}: {
  provider: typeof provider
  worker?: ProviderLocalWorkerStatus
}) {
  const dispatch = useProviderDispatch(configuration)
  const changeMode = useProviderLocalWorkerMode(configuration.id)
  return (
    <>
      <p>{dispatchStateLabel(dispatch)}</p>
      <ProviderDispatchActions dispatch={dispatch} />
      <ProviderDispatchNotes dispatch={dispatch} />
      <ProviderDispatchReview dispatch={dispatch} />
      {configuration.supportsJobDispatchControl && (
        <ProviderWorkerModeSwitch
          worker={worker}
          dispatch={dispatch}
          changeMode={changeMode}
        />
      )}
    </>
  )
}

function render(
  data: unknown = stopped,
  configuration = provider,
  worker?: ProviderLocalWorkerStatus,
) {
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
        <Dispatch provider={configuration} worker={worker} />
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
  assert.match(html, /<p>Stopped<\/p>/)
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
  assert.match(html, /Paused and stopped/)
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
  assert.match(html, /Stopped · 1 active dispatch/)
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
    '<p></p>',
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

const worker = ProviderLocalWorkerStatusSchema.parse({
  mode: 'local',
  configured: true,
  paired: true,
  online: true,
  blocked: false,
  active: false,
  lastSeenAt: 1700000000000,
  supportsModeSwitch: true,
})
const workerProvider = { ...provider, supportsLocalWorker: true }
const paused = { ...stopped, paused: true }

test('switchable providers can explicitly change mode in either direction after pausing', () => {
  assert.doesNotMatch(
    button(render(paused, workerProvider, worker), 'Switch to Cloudflare'),
    /disabled=""/,
  )
  const cloud = render(paused, workerProvider, {
    ...worker,
    mode: 'cloud',
    online: false,
    paired: false,
    lastSeenAt: null,
  })
  assert.doesNotMatch(button(cloud, 'Switch to Local'), /disabled=""/)
  assert.doesNotMatch(
    render(paused, workerProvider, { ...worker, supportsModeSwitch: false }),
    /Switch to/,
  )
})

test('transport switching waits for paused, drained dispatch and a clear local worker', () => {
  const active = {
    ...paused,
    slots: [
      { jobId: 'fixture-job', phase: 'running', expiresAt: 1700000000000 },
    ],
  }
  for (const state of [stopped, active]) {
    const html = render(state, workerProvider, worker)
    assert.match(button(html, 'Switch to Cloudflare'), /disabled=""/)
    assert.match(html, /Pause the queue and wait for active work to finish/)
  }
  const blocked = render(paused, workerProvider, { ...worker, blocked: true })
  assert.match(button(blocked, 'Switch to Cloudflare'), /disabled=""/)
  assert.match(blocked, /Review the local request before switching/)
})
