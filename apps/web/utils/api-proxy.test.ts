import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { createNodeApiRequest, proxyApiRequest } from './api-proxy'
import { isForbiddenPublicPath, privateResponse } from './private-response'
import { readServerSession } from './server-session'

test('API proxy preserves method, path, query, body, cookies and origin without redirects', async () => {
  const request = new Request(
    'https://media.example/api/v1/imports?preview=true',
    {
      method: 'POST',
      body: 'synthetic import',
      headers: {
        cookie: 'session=synthetic',
        origin: 'https://media.example',
        'content-type': 'text/plain',
        'x-forwarded-host': 'attacker.example',
        'x-forwarded-for': 'spoofed',
        'x-real-ip': 'spoofed',
        'cf-connecting-ip': '192.0.2.99',
        'x-media-client-ip': '192.0.2.99',
      },
    },
  )
  const response = await proxyApiRequest(request, async (upstream) => {
    assert.equal(upstream.url, request.url)
    assert.equal(upstream.method, 'POST')
    assert.equal(upstream.redirect, 'manual')
    assert.equal(await upstream.text(), 'synthetic import')
    assert.equal(upstream.headers.get('cookie'), 'session=synthetic')
    assert.equal(upstream.headers.get('origin'), 'https://media.example')
    assert.equal(upstream.headers.get('content-type'), 'text/plain')
    assert.equal(upstream.headers.get('x-forwarded-host'), 'media.example')
    assert.equal(upstream.headers.get('x-forwarded-proto'), 'https')
    assert.equal(upstream.headers.get('x-forwarded-for'), null)
    assert.equal(upstream.headers.get('x-real-ip'), null)
    assert.equal(upstream.headers.get('cf-connecting-ip'), null)
    assert.equal(upstream.headers.get('x-media-client-ip'), null)
    const headers = new Headers({
      location: 'https://media.example/albums',
      'cache-control': 'public, max-age=300',
    })
    headers.append('set-cookie', 'first=one; HttpOnly; Secure; Path=/')
    headers.append('set-cookie', 'second=two; HttpOnly; Secure; Path=/')
    return new Response(null, { status: 302, headers })
  })
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), 'https://media.example/albums')
  assert.equal(response.headers.getSetCookie().length, 2)
  assert.equal(
    response.headers.get('Cache-Control'),
    'private, no-store, max-age=0',
  )
  assert.equal(response.headers.get('Cloudflare-CDN-Cache-Control'), 'no-store')
})

test('API proxy rejects non-API requests and sanitizes binding failures', async () => {
  const response = await proxyApiRequest(
    new Request('https://media.example/albums'),
    async () => {
      throw new Error('must not be reached')
    },
  )
  assert.equal(response.status, 404)
  const failed = await proxyApiRequest(
    new Request('https://media.example/api/auth/get-session'),
    async () => {
      throw new Error('private connection details')
    },
  )
  assert.equal(failed.status, 502)
  assert.deepEqual(await failed.json(), { message: 'API unavailable' })
})

test('Node requests identity encoding without changing request semantics or browser headers', async () => {
  const original = new Request(
    'https://media.example/api/v1/imports?preview=true',
    {
      method: 'POST',
      body: 'synthetic import',
      redirect: 'manual',
      headers: {
        'accept-encoding': 'gzip, deflate, br',
        'content-type': 'text/plain',
        cookie: 'session=synthetic',
        origin: 'https://media.example',
      },
    },
  )
  const upstream = createNodeApiRequest(
    original,
    new URL('http://localhost:4000'),
  )
  assert.equal(
    upstream.url,
    'http://localhost:4000/api/v1/imports?preview=true',
  )
  assert.equal(upstream.headers.get('accept-encoding'), 'identity')
  assert.equal(original.headers.get('accept-encoding'), 'gzip, deflate, br')
  assert.equal(upstream.method, 'POST')
  assert.equal(upstream.redirect, 'manual')
  assert.equal(upstream.headers.get('cookie'), 'session=synthetic')
  assert.equal(upstream.headers.get('origin'), 'https://media.example')
  assert.equal(upstream.headers.get('content-type'), 'text/plain')
  assert.equal(await upstream.text(), 'synthetic import')
})

test('Node HTTP proxy returns JSON with matching headers from a gzip-capable backend', async (t) => {
  const rawJson = JSON.stringify({
    data: 'Synthetic private media '.repeat(256),
  })
  const acceptedEncodings: (string | undefined)[] = []
  const server = createServer((request, response) => {
    const accepted = request.headers['accept-encoding']
    acceptedEncodings.push(accepted)
    const compressed = accepted?.includes('gzip') ?? false
    const body = compressed ? gzipSync(rawJson) : Buffer.from(rawJson)
    response.setHeader('content-type', 'application/json')
    response.setHeader('content-length', body.byteLength)
    if (compressed) response.setHeader('content-encoding', 'gzip')
    response.end(body)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing local test port')
  const backend = new URL(`http://127.0.0.1:${address.port}`)

  // Demonstrate why forwarding browser negotiation through Node fetch is unsafe.
  const direct = await fetch(backend, {
    headers: { 'accept-encoding': 'gzip' },
  })
  assert.equal(direct.headers.get('content-encoding'), 'gzip')
  const decoded = await direct.text()
  assert.equal(decoded, rawJson)
  assert.notEqual(
    Number(direct.headers.get('content-length')),
    Buffer.byteLength(decoded),
  )

  const response = await proxyApiRequest(
    new Request('https://media.example/api/v1/albums', {
      headers: { 'accept-encoding': 'gzip, deflate, br' },
    }),
    (upstream) =>
      fetch(createNodeApiRequest(upstream, backend), { cache: 'no-store' }),
  )
  assert.deepEqual(acceptedEncodings, ['gzip', 'identity'])
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-encoding'), null)
  assert.match(response.headers.get('cache-control') ?? '', /no-store/)
  const bytes = new Uint8Array(await response.arrayBuffer())
  assert.equal(bytes.byteLength, Number(response.headers.get('content-length')))
  assert.equal(new TextDecoder().decode(bytes), rawJson)
})

test('Cloudflare proxy and outer private wrapper preserve raw JSON without encoding headers', async () => {
  const payload = { data: { title: 'Synthetic private media '.repeat(256) } }
  const rawJson = JSON.stringify(payload)
  const upstream = new Response(rawJson, {
    headers: {
      'content-type': 'application/json',
      'content-length': String(new TextEncoder().encode(rawJson).byteLength),
    },
  })
  const proxy = await proxyApiRequest(
    new Request('https://media.example/api/v1/albums', {
      headers: { 'accept-encoding': 'gzip, deflate, br' },
    }),
    async () => upstream,
  )
  const response = privateResponse(proxy)
  assert.equal(response.status, 200)
  assert.equal(response.body, upstream.body)
  assert.equal(response.headers.get('content-encoding'), null)
  assert.equal(response.headers.get('content-type'), 'application/json')
  assert.match(response.headers.get('cache-control') ?? '', /no-store/)
  const bytes = new Uint8Array(await response.arrayBuffer())
  assert.equal(bytes.byteLength, Number(response.headers.get('content-length')))
  assert.equal(bytes[0], 0x7b)
  assert.equal(new TextDecoder().decode(bytes), rawJson)
})

test('all private responses override shared cache headers without buffering the body', async () => {
  const response = privateResponse(
    new Response('private', {
      headers: {
        'cache-control': 'public, s-maxage=900',
        'cdn-cache-control': 'public',
        'cloudflare-cdn-cache-control': 'public',
      },
    }),
  )
  assert.equal(await response.text(), 'private')
  assert.equal(response.headers.get('cdn-cache-control'), 'no-store')
  assert.equal(response.headers.get('cloudflare-cdn-cache-control'), 'no-store')
})

test('private legacy inputs and maps cannot be requested as public assets', () => {
  for (const path of [
    '/data',
    '/data/library.json',
    '/config.json',
    '/_next/static/chunk.js.map',
    '/%64ata/library.json',
    '/%2fdata/library.json',
    '/icons/../data/library.json',
    '/%ZZ',
  ]) {
    assert.equal(isForbiddenPublicPath(path), true, path)
  }
  for (const path of [
    '/albums',
    '/_next/static/chunk.js',
    '/icons/ratings/imdb.svg',
    '/database',
  ]) {
    assert.equal(isForbiddenPublicPath(path), false, path)
  }
})

test('server session validates boundary data and fails closed', async () => {
  const session = {
    user: {
      id: 'user',
      email: 'owner@example.test',
      name: 'Owner',
      role: 'owner',
    },
    session: { id: 'session', userId: 'user' },
  }
  assert.deepEqual(await readServerSession(Response.json(session)), session)
  for (const value of [
    null,
    {},
    { user: session.user },
    { ...session, session: { id: 'session', userId: 'other' } },
  ]) {
    assert.deepEqual(await readServerSession(Response.json(value)), {
      user: null,
      session: null,
    })
  }
  assert.deepEqual(
    await readServerSession(new Response(null, { status: 503 })),
    { user: null, session: null },
  )
})
