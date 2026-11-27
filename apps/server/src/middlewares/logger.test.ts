import { Hono } from 'hono'
import { Pool as NeonPool } from '@neondatabase/serverless'
import { sql } from 'drizzle-orm'
import pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ListeningFilterSchema } from '@repo/schemas/listening'
import { SONOS_PAGE_HEADER, SONOS_REASON_HEADER } from '@repo/schemas/sonos'
import { db as cloudDb, withCloudDatabase } from '@/cloudflare/db'
import { db as nodeDb } from '@/lib/db'
import {
  logApiRequest,
  measureCatalogWriteLock,
  measureRequestPhase,
  recordRecordingOrderLookup,
  requestQueryLogger,
  setPlaybackLogRole,
  setRequestBrowseProfile,
  setRequestLogRoute,
} from '@/lib/request-log'
import { createSonosRequestFetch } from '@/lib/sonos-request-log'
import { listeningRuleProfile } from '@/services/browse-listening'
import { logger } from './logger'

const runtime = vi.hoisted(() => ({
  RUNTIME_KIND: 'node',
  DATABASE_URL: 'postgresql://fixture.invalid.neon.tech/fixture',
}))
vi.mock('@/env', () => ({ env: runtime }))

const app = new Hono()
app.use(logger())
app.get('/api/v1/tracks/browse-page', (c) => c.body(null, 200))
app.get('/api/v1/tracks/forward', (_c, next) => next())
app.get('/api/v1/tracks/:id', (c) => c.body(null, 204))
app.get('/api/v1/sonos/groups/:id/state', async (c) => {
  await createSonosRequestFetch('oauth.refresh')(
    'https://api.ws.sonos.com/control/api/v1/groups/fixture-room/playback',
    {},
  )
  return c.body(null, 422)
})

app.get('/api/v1/playback/session', (c) => {
  setPlaybackLogRole('follower')
  return c.body(null, 200)
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
  playbackRole: z.enum(['driver', 'follower']).optional(),
  stateReason: z.literal('room-watching').optional(),
  drizzleStatementCount: z.number().optional(),
  browse: z
    .object({
      grouped: z.boolean(),
      depth: z.enum(['first', 'near', 'deep']),
      listening: z.boolean(),
      listeningUse: z.enum(['filter', 'column', 'both']).optional(),
      listeningRules: z
        .object({
          count: z.enum(['one', 'multiple']),
          match: z.enum(['all', 'any']),
          period: z.enum(['all', 'dates', 'rolling', 'mixed']),
          threshold: z.enum([
            'present',
            'absent',
            'presentAndAbsent',
            'count',
            'presenceAndCount',
          ]),
        })
        .optional(),
      filtered: z.boolean(),
      searchTerms: z.enum(['one', 'multiple']).optional(),
      creatorScoped: z.boolean().optional(),
      sort: z.enum(['added', 'title', 'plays', 'other']),
      sortField: z.string().optional(),
      filterFields: z.array(z.string()).optional(),
      rangeFields: z.array(z.string()).optional(),
      playSort: z.enum(['scrobbles', 'listeningScrobbles']).optional(),
      recordingOrderLookup: z.enum(['hit', 'miss']).optional(),
    })
    .optional(),
  phases: z
    .record(
      z.string(),
      z.object({
        durationMs: z.number().nonnegative(),
        drizzleStatementCount: z.number().nonnegative(),
      }),
    )
    .optional(),
})

afterEach(() => {
  runtime.RUNTIME_KIND = 'node'
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('logs the registered route that handled a request with multiple matches', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  await serve('/api/v1/tracks/browse-page?search=fixture-secret', '')
  await serve('/api/v1/tracks/fixture-secret', '')
  await serve('/api/v1/tracks/forward', '')
  const logs = info.mock.calls.map(([line]) =>
    RecordSchema.parse(JSON.parse(line)),
  )
  expect(logs.map(({ route, status }) => [route, status])).toEqual([
    ['/api/v1/tracks/browse-page', 200],
    ['/api/v1/tracks/:id', 204],
    ['/api/v1/tracks/:id', 204],
  ])
  expect(JSON.stringify(info.mock.calls)).not.toContain('fixture-secret')
})

it.each([
  ['/api/v1/library-changes/track-merges', 'POST'],
  ['/api/v1/tracks/:id/merge', 'POST'],
  ['/api/v1/tidal/similar/:kind/:id', 'GET'],
])('measures the catalog lock separately on %s', async (route, method) => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const request = new Request('https://example.test', { method })
  await logApiRequest(request, async () => {
    setRequestLogRoute(route, request.headers)
    await measureCatalogWriteLock(async () =>
      requestQueryLogger.logQuery('select 1', []),
    )
    requestQueryLogger.logQuery('select 2', [])
    return new Response(null, { status: 200 })
  })
  expect(
    info.mock.calls.map(([line]) => RecordSchema.parse(JSON.parse(line))),
  ).toMatchObject([
    {
      route,
      drizzleStatementCount: 2,
      phases: { catalogWriteLock: { drizzleStatementCount: 1 } },
    },
  ])
})

it('counts Drizzle executions and phases separately across concurrent requests', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const driverError = new Error('fixture driver failure')
  vi.spyOn(pg.Pool.prototype, 'query').mockImplementation(() => {
    throw driverError
  })
  vi.spyOn(NeonPool.prototype, 'query').mockImplementation(() => {
    throw driverError
  })
  const statement = sql`select ${'fixture-bind-secret'} as fixture_statement`
  const request = new Request('https://fixture.invalid')
  const browse = {
    grouped: true,
    depth: 'first',
    listening: true,
    listeningUse: 'both',
    listeningRules: {
      count: 'multiple',
      match: 'any',
      period: 'mixed',
      threshold: 'presenceAndCount',
    },
    filtered: false,
    creatorScoped: false,
    searchTerms: 'multiple',
    sort: 'plays',
    playSort: 'listeningScrobbles',
    sortField: 'listeningScrobbles',
    filterFields: ['artistTag', 'other'],
    rangeFields: ['durationSec'],
  } satisfies NonNullable<z.infer<typeof RecordSchema>['browse']>
  // Executing without a request, as a background job would, emits no record.
  await expect(nodeDb.execute(statement)).rejects.toThrow()

  await Promise.all([
    logApiRequest(request, async () => {
      setRequestBrowseProfile({
        ...browse,
        listeningRules: listeningRuleProfile(
          ListeningFilterSchema.parse({
            match: 'any',
            rules: [
              {
                period: { kind: 'rolling', amount: 17, unit: 'weeks' },
                min: 1,
              },
              {
                period: { kind: 'dates', from: '2001-05-17', to: '2001-05-29' },
                min: 81_371,
              },
            ],
          }),
        ),
        filterFields: ['fixture-private-field', 'artistTag', 'artistTag'],
      })
      recordRecordingOrderLookup('hit')
      await Promise.all([
        measureRequestPhase('ids', async () => {
          const prepared = nodeDb
            .select({ value: sql<string>`${sql.placeholder('value')}` })
            .from(sql`(select 1) as fixture_input`)
            .prepare('fixture_prepared')
          await expect(
            prepared.execute({ value: 'fixture-bind-secret' }),
          ).rejects.toThrow()
          await expect(nodeDb.execute(statement)).rejects.toThrow()
        }),
        measureRequestPhase('hydrate', async () => {
          await expect(nodeDb.execute(statement)).rejects.toThrow()
        }),
      ])
      await measureRequestPhase('ids', async () => {
        await expect(nodeDb.execute(statement)).rejects.toThrow()
      })
      return new Response(null, { status: 204 })
    }),
    logApiRequest(request, () =>
      withCloudDatabase(async () => {
        await measureRequestPhase('count', async () => {
          const prepared = cloudDb
            .select({ value: sql<string>`${sql.placeholder('value')}` })
            .from(sql`(select 1) as fixture_input`)
            .prepare('fixture_prepared')
          await expect(
            prepared.execute({ value: 'fixture-bind-secret' }),
          ).rejects.toThrow()
        })
        await expect(cloudDb.execute(statement)).rejects.toThrow()
        return new Response(null, { status: 200 })
      }),
    ),
  ])

  const logs = info.mock.calls.map(([line]) =>
    RecordSchema.parse(JSON.parse(line)),
  )
  expect(logs).toHaveLength(2)
  expect(logs.find(({ status }) => status === 204)).toMatchObject({
    drizzleStatementCount: 4,
    browse: { ...browse, recordingOrderLookup: 'hit' },
    phases: {
      ids: { drizzleStatementCount: 3 },
      hydrate: { drizzleStatementCount: 1 },
    },
  })
  expect(logs.find(({ status }) => status === 200)).toMatchObject({
    drizzleStatementCount: 2,
    phases: { count: { drizzleStatementCount: 1 } },
  })
  expect(logs.find(({ status }) => status === 200)?.browse).toBeUndefined()
  expect(
    Object.keys(logs.find(({ status }) => status === 200)?.phases ?? {}),
  ).toEqual(['count'])
  expect(JSON.stringify(info.mock.calls)).not.toMatch(/fixture[_-]/)
  expect(JSON.stringify(info.mock.calls)).not.toMatch(
    /2001-05-(17|29)|81371|"amount"|"weeks"|"min"|"max"/,
  )
})

it.each([
  { rules: [], threshold: undefined, count: undefined },
  { rules: [{ min: 1 }], threshold: 'present', count: 'one' },
  { rules: [{ max: 0 }], threshold: 'absent', count: 'one' },
  {
    rules: [{ min: 1 }, { max: 0 }],
    threshold: 'presentAndAbsent',
    count: 'multiple',
  },
  { rules: [{ min: 2 }, { max: 5 }], threshold: 'count', count: 'multiple' },
])(
  'classifies grouped rule thresholds as $threshold',
  ({ rules, threshold, count }) => {
    const filter = ListeningFilterSchema.parse({
      match: 'all',
      rules: rules.map((rule) => ({ ...rule, period: { kind: 'all' } })),
    })
    const profile = listeningRuleProfile(filter)
    if (threshold === undefined) expect(profile).toBeUndefined()
    else
      expect(profile).toEqual({ count, match: 'all', period: 'all', threshold })
  },
)

it('records only built-in sort and range fields', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  await logApiRequest(new Request('https://fixture.invalid'), () => {
    setRequestBrowseProfile({
      grouped: false,
      depth: 'first',
      listening: false,
      filtered: true,
      sort: 'other',
      sortField: 'fixture-extension',
      rangeFields: ['fixture-extension'],
      listeningRules: {
        count: 'one',
        match: 'all',
        period: 'all',
        threshold: 'present',
      },
    })
    return new Response()
  })
  const [line] = info.mock.calls[0] ?? []
  const { browse } = RecordSchema.parse(JSON.parse(line))
  expect(browse?.sortField).toBe('other')
  expect(browse?.rangeFields).toEqual(['other'])
  expect(browse?.listeningRules).toBeUndefined()
  expect(JSON.stringify(info.mock.calls)).not.toContain('fixture-extension')
})

it('preserves the request result and thrown error when log delivery fails', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {
    throw new Error('fixture log failure')
  })
  const request = new Request('https://fixture.invalid')
  const response = new Response(null, { status: 204 })
  const operationError = new Error('fixture operation failure')
  await expect(logApiRequest(request, () => response)).resolves.toBe(response)
  await expect(
    logApiRequest(request, () => {
      throw operationError
    }),
  ).rejects.toBe(operationError)
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

it('identifies the same anonymous page on a player heartbeat and a room request', async () => {
  runtime.RUNTIME_KIND = 'cloudflare'
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null)),
  )
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const id = '00000000-0000-4000-8000-000000000001'
  await serve('/api/v1/playback/session', id + '/visible')
  await serve('/api/v1/sonos/groups/fixture-room/state', id + '/hidden')
  const records = info.mock.calls.map(([value]) => RecordSchema.parse(value))
  expect(records[0]).toMatchObject({
    event: 'api.request',
    route: '/api/v1/playback/session',
    playbackRole: 'follower',
    visibility: 'visible',
  })
  expect(records[0]?.page).toBeDefined()
  expect(records[0]?.page).toBe(records.at(-1)?.page)
  expect(JSON.stringify(info.mock.calls)).not.toContain(id)
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
  expect(logs.at(-1)).toMatchObject({
    event: 'api.request',
    route: 'unmatched',
    status: 404,
    drizzleStatementCount: 0,
  })
})

it.each([
  ['/api/v1/tracks/browse-page', 200, true, true],
  ['/api/v1/tracks/browse-count', 200, true, true],
  ['/api/v1/tracks/browse-page', 200, false, false],
  ['/api/v1/tracks/browse-page', 401, true, false],
  ['/api/v1/tracks/positions', 200, true, false],
])(
  'requests only due foreground recording maintenance for %s',
  async (route, status, due, requested) => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const request = new Request('https://fixture.invalid')
    const requestRefresh = vi.fn(() => {
      expect(info).toHaveBeenCalledOnce()
      expect(() => cloudDb.execute(sql`select 1`)).toThrow(
        'outside a Worker invocation',
      )
    })

    const response = await logApiRequest(
      request,
      () =>
        withCloudDatabase(async () => {
          setRequestLogRoute(route, request.headers)
          setRequestBrowseProfile({
            grouped: true,
            depth: 'first',
            listening: false,
            filtered: false,
            sort: 'plays',
          })
          recordRecordingOrderLookup('miss', due)
          return new Response(null, { status })
        }),
      requestRefresh,
    )

    expect(response.status).toBe(status)
    expect(requestRefresh).toHaveBeenCalledTimes(Number(requested))
  },
)

it('returns the completed response when maintenance registration throws', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  const request = new Request('https://fixture.invalid')
  const refresh = vi.fn(() => {
    throw new Error('fixture registration failure')
  })
  const response = new Response(null, { status: 200 })
  expect(
    await logApiRequest(
      request,
      () => {
        setRequestLogRoute('/api/v1/tracks/browse-page', request.headers)
        setRequestBrowseProfile({
          grouped: true,
          depth: 'first',
          listening: false,
          filtered: false,
          sort: 'plays',
        })
        recordRecordingOrderLookup('miss', true)
        return response
      },
      refresh,
    ),
  ).toBe(response)
  expect(refresh).toHaveBeenCalledOnce()
})
