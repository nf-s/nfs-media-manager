import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { fetchApiData } from './api'

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
