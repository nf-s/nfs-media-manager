import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { SONOS_PAGE_HEADER, SonosPageHeaderSchema } from '@repo/schemas/sonos'
import { createSessionApi } from './playback-sync'
import { fetchApiData } from './api'

test('Sonos reads from one page share a diagnostic ID and report its current visibility', async (t) => {
  const document = { visibilityState: 'visible' }
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: document,
  })
  t.after(() => {
    Reflect.deleteProperty(globalThis, 'document')
  })
  const pages: Array<string | null> = []
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: string, init: RequestInit) => {
      pages.push(new Headers(init.headers).get(SONOS_PAGE_HEADER))
      return Response.json({ statusCode: 200, message: 'OK', data: 'ok' })
    },
  )
  await fetchApiData('', '/api/v1/sonos/rooms', z.string())
  document.visibilityState = 'hidden'
  await fetchApiData('', '/api/v1/sonos/groups/example/state', z.string())
  await fetchApiData('', '/api/v1/playback/session', z.string(), {
    method: 'POST',
  })
  await fetchApiData('', '/api/v1/healthcheck', z.string())
  const [page, visibility] = SonosPageHeaderSchema.parse(pages[0])
  assert.equal(visibility, 'visible')
  assert.deepEqual(SonosPageHeaderSchema.parse(pages[1]), [page, 'hidden'])
  assert.deepEqual(SonosPageHeaderSchema.parse(pages[2]), [page, 'hidden'])
  assert.equal(pages[3], null)
})

test('a newer player can share Spotify with an older API and detects a server upgrade', async (t) => {
  const api = createSessionApi('')
  const input = {
    clientId: 'test-player',
    clientName: 'Fixture',
    revision: 0,
    claim: false,
    sonosManaged: true,
  } satisfies Parameters<typeof api.sync>[0]
  const calls: boolean[] = []
  let upgraded = false
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: string, init: RequestInit) => {
      const body = z
        .object({ sonosManaged: z.boolean().optional() })
        .parse(JSON.parse(String(init.body)))
      calls.push(body.sonosManaged === true)
      if (body.sonosManaged && !upgraded)
        return Response.json(
          {
            statusCode: 422,
            message: 'Validation Error',
            data: { issues: [{ code: 'unrecognized_keys', path: '(root)' }] },
          },
          { status: 422 },
        )
      return Response.json({
        statusCode: 200,
        message: 'OK',
        data: {
          role: 'driver',
          driver: null,
          changed: false,
          revision: 0,
          state: null,
          ...(upgraded && { sonosManaged: Boolean(body.sonosManaged) }),
        },
      })
    },
  )
  assert.equal((await api.sync(input)).sonosManaged, undefined)
  assert.equal((await api.sync(input)).sonosManaged, undefined)
  upgraded = true
  assert.equal((await api.sync(input)).sonosManaged, false)
  assert.equal((await api.sync(input)).sonosManaged, true)
  assert.deepEqual(calls, [true, false, false, false, true])
})

const errorData = {
  status: 409,
  schema: z.object({ code: z.literal('known-conflict'), targetId: z.string() }),
}
const conflict = {
  statusCode: 409,
  message: 'Recordings conflict.',
  data: { code: 'known-conflict', targetId: 'existing-item' },
}

test('API requests opt in to validated error details for a specific status', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: string, init: RequestInit) => {
      assert.equal(init.method, 'POST')
      assert.equal(Object.hasOwn(init, 'errorData'), false)
      return Response.json(
        {
          ...conflict,
          data: { ...conflict.data, extra: 'field outside the schema' },
        },
        { status: 409 },
      )
    },
  )

  await assert.rejects(
    fetchApiData('', '/accept', z.string(), { method: 'POST', errorData }),
    (error: unknown) => {
      assert.deepEqual(error, conflict)
      return true
    },
  )
})

test('API errors preserve generic fields with missing opt-in, mismatched status or invalid details', async (t) => {
  const { data, ...expected } = conflict
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(conflict, { status: 409 }),
  )
  const checkError = (error: unknown) => {
    assert.deepEqual(error, expected)
    return true
  }
  await assert.rejects(fetchApiData('', '/accept', z.string()), checkError)

  t.mock.restoreAll()
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(conflict, { status: 500 }),
  )
  await assert.rejects(
    fetchApiData('', '/accept', z.string(), { errorData }),
    checkError,
  )

  t.mock.restoreAll()
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ ...conflict, data: { code: data.code } }, { status: 409 }),
  )
  await assert.rejects(
    fetchApiData('', '/accept', z.string(), { errorData }),
    checkError,
  )
})
