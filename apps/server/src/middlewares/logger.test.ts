import { Hono } from 'hono'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SONOS_PAGE_HEADER, SONOS_REASON_HEADER } from '@repo/schemas/sonos'
import { logApiRequest } from '@/lib/request-log'
import { createSonosRequestFetch } from '@/lib/sonos-request-log'
import { logger } from './logger'

const runtime = vi.hoisted(() => ({ RUNTIME_KIND: 'node' }))
vi.mock('@/env', () => ({ env: runtime }))

const app = new Hono()
app.use(logger())
app.get('/api/v1/sonos/groups/:id/state', async (c) => {
  await createSonosRequestFetch('oauth.refresh')(
    'https://api.ws.sonos.com/control/api/v1/groups/fixture-room/playback',
    {},
  )
  return c.body(null, 422)
})

function serve(path: string, page: string, reason = 'room-watching') {
  const request = new Request(new URL(path, 'https://fixture.invalid'), {
    headers: {
      [SONOS_PAGE_HEADER]: page,
      [SONOS_REASON_HEADER]: reason,
      Authorization: 'Bearer fixture-auth',
    },
  })
  return logApiRequest(request, () => app.fetch(request))
}

const RecordSchema = z.object({
  requestId: z.uuidv4(),
  event: z.string(),
  status: z.number().optional(),
  attemptId: z.uuidv4().optional(),
  route: z.string(),
  page: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
  visibility: z.enum(['visible', 'hidden']).optional(),
  stateReason: z.literal('room-watching').optional(),
})

afterEach(() => {
  runtime.RUNTIME_KIND = 'node'
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('correlates concurrent Sonos sends with the initiating page and access result', async () => {
  runtime.RUNTIME_KIND = 'cloudflare'
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 429 })),
  )
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const id = '00000000-0000-4000-8000-000000000001'
  const path = '/api/v1/sonos/groups/fixture-room/state?track=fixture-track'
  await Promise.all([serve(path, id + '/visible'), serve(path, id + '/hidden')])
  const logs = info.mock.calls.map(([record]) => RecordSchema.parse(record))
  expect(logs).toHaveLength(6)
  expect(new Set(logs.map((log) => log.page)).size).toBe(1)
  expect(new Set(logs.map((log) => log.requestId)).size).toBe(2)
  for (const visibility of ['visible', 'hidden']) {
    const events = logs.filter((log) => log.visibility === visibility)
    expect(new Set(events.map((log) => log.requestId)).size).toBe(1)
    expect(events.map((log) => [log.event, log.status])).toEqual([
      ['sonos.dispatch', undefined],
      ['sonos.request', 429],
      ['api.request', 422],
    ])
    expect(events[0]?.attemptId).toBeDefined()
    expect(events[1]?.attemptId).toBe(events[0]?.attemptId)
    expect(
      events.every(
        (log) =>
          log.page &&
          log.route === '/api/v1/sonos/groups/:id/state' &&
          log.stateReason === 'room-watching',
      ),
    ).toBe(true)
  }
  expect(JSON.stringify(info.mock.calls)).not.toMatch(
    /fixture-(?:room|track|auth)|00000000-0000-4000/,
  )
})

it('omits unrecognized paths and untrusted correlation headers', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null)),
  )
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  await serve(
    '/api/v1/sonos/groups/fixture-room/state',
    'fixture-invalid/hidden',
    'fixture-invalid',
  )
  await serve('/fixture-unknown/fixture-secret', 'fixture-invalid')
  expect(JSON.stringify(info.mock.calls)).not.toContain('fixture-')
  const logs = info.mock.calls.map(([line]) =>
    RecordSchema.parse(JSON.parse(line)),
  )
  expect(
    logs.every(
      (log) =>
        log.page === undefined &&
        log.visibility === undefined &&
        log.stateReason === undefined,
    ),
  ).toBe(true)
  expect(logs.at(-1)).toMatchObject({ event: 'api.request', status: 404 })
})
