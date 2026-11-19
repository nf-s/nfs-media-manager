import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LOCAL_RESPONSE_BYTES } from '@repo/media-plugin-sdk/local-worker'
import { loadConfig } from '../dist/config.js'
import { readBody } from '../dist/http.js'
import {
  createFilteredTransport,
  defaultResponseFilter,
  loadResponseFilter,
  readFilteredCapture,
} from '../dist/response-filter.js'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'local-worker-filter-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const config = loadConfig({
    LOCAL_WORKER_URL: 'https://app.example',
    LOCAL_WORKER_PROVIDER: 'fixture',
    LOCAL_WORKER_TOKEN: 'synthetic-owner-token',
    LOCAL_WORKER_ORIGIN: 'https://provider.example',
    LOCAL_WORKER_PATHS: '/api',
    LOCAL_WORKER_STATE_DIR: directory,
    LOCAL_WORKER_CREDENTIALS: '{"authorization":"EXAMPLE_API_TOKEN"}',
    EXAMPLE_API_TOKEN: 'synthetic-provider-token',
  })
  const options = {
    method: 'GET',
    headers: {},
    signal: new AbortController().signal,
  }
  return { config, directory, options }
}

test('filter loads only an explicit owner-controlled absolute module', async (t) => {
  const { directory } = fixture(t)
  assert.equal(await loadResponseFilter(undefined), undefined)
  const module = join(directory, 'response-filter.mjs')
  writeFileSync(module, 'export const sanitizeResponse = value => value', {
    mode: 0o600,
  })
  assert.equal(typeof (await loadResponseFilter(module)), 'function')
  await assert.rejects(
    loadResponseFilter('response-filter.mjs'),
    /owner-controlled/,
  )
  const linked = join(directory, 'link.mjs')
  symlinkSync(module, linked)
  await assert.rejects(loadResponseFilter(linked), /owner-controlled/)
  const malformed = join(directory, 'invalid.mjs')
  writeFileSync(malformed, 'export const different = () => null')
  await assert.rejects(loadResponseFilter(malformed), /sanitizeResponse/)
})

test('only provider GET is filtered and private archive has no credential headers', async (t) => {
  const { config, directory, options } = fixture(t)
  const calls = []
  const filtered = createFilteredTransport(
    config,
    ({ contentType, text, sensitiveValues }) => {
      calls.push(sensitiveValues.length)
      return { contentType, text: text.replace('uploader', '[redacted]') }
    },
    async () =>
      new Response('uploader synthetic-provider-token', {
        headers: {
          'content-type': 'text/plain',
          'set-cookie': 'private-cookie',
          'retry-after': '10',
        },
      }),
  )
  const cloud = await filtered('https://app.example/control', {
    ...options,
    method: 'POST',
  })
  assert.equal(cloud.capture, undefined)
  assert.deepEqual(calls, [])
  const response = await filtered('https://provider.example/api', options)
  assert.deepEqual(calls, [2])
  assert.equal(response.headers.has('set-cookie'), false)
  assert.equal(response.headers.get('retry-after'), '10')
  assert.equal(
    await readBody(response, LOCAL_RESPONSE_BYTES, options.signal),
    '[redacted] [redacted]',
  )
  assert.equal(response.capture.body.state, 'captured')
  assert.deepEqual(response.nativeBody, { redacted: true })
  const captureDir = join(directory, 'capture')
  const [file] = readdirSync(captureDir)
  assert.equal(statSync(captureDir).mode & 0o777, 0o700)
  assert.equal(statSync(join(captureDir, file)).mode & 0o777, 0o600)
  assert.equal(
    readFilteredCapture(directory, file.slice(0, -5)).text,
    '[redacted] [redacted]',
  )
})

test('large captures use a local receipt and failed sanitization preserves rate status', async (t) => {
  const { config, directory, options } = fixture(t)
  const large = 'x'.repeat(LOCAL_RESPONSE_BYTES * 0.7)
  const filtered = createFilteredTransport(
    config,
    ({ text }) => ({
      contentType: 'text/html',
      text,
    }),
    async () => new Response(large),
  )
  const response = await filtered('https://provider.example/api', options)
  assert.equal(response.capture.body.state, 'local')
  assert.deepEqual(response.nativeBody, { redacted: false })
  assert.equal(
    readFilteredCapture(directory, response.capture.body.reference).text,
    large,
  )

  const reject = createFilteredTransport(
    config,
    () => null,
    async () =>
      new Response('private', {
        status: 429,
        headers: { 'retry-after': '120' },
      }),
  )
  const blocked = await reject('https://provider.example/api', options)
  assert.equal(blocked.status, 429)
  assert.equal(blocked.headers.get('retry-after'), '120')
  assert.equal(blocked.body, null)
  assert.equal(blocked.capture.body.reason, 'unsupported-format')
})

test('default filter preserves native catalogue JSON and bodyless success without an opt-in module', async (t) => {
  const { config, directory, options } = fixture(t)
  let calls = 0
  const filtered = createFilteredTransport(
    config,
    defaultResponseFilter,
    async () => {
      calls++
      return calls === 1
        ? new Response(
            '{"secret":"private-k","unknown":{"large":9223372036854775811}}',
          )
        : new Response(null, { status: 204 })
    },
  )
  const response = await filtered('https://provider.example/api', options)
  const body = await readBody(response, LOCAL_RESPONSE_BYTES, options.signal)
  assert.equal(response.headers.get('content-type'), 'application/json')
  assert.doesNotMatch(body, /private-k/)
  assert.match(body, /9223372036854775811/)
  assert.equal(response.capture.body.text, body)
  assert.deepEqual(response.nativeBody, { redacted: true })
  assert.equal(readdirSync(join(directory, 'capture')).length, 1)
  const empty = await filtered('https://provider.example/api', options)
  assert.equal(empty.status, 204)
  assert.equal(empty.body, null)
  assert.equal(empty.capture.body.reason, 'empty')
  assert.equal(calls, 2)
})
