import assert from 'node:assert/strict'
import { test } from 'node:test'
import { protectCloudAuth } from './cloud-auth'
import { proxyApiRequest, trustedClientIpHeader } from './api-proxy'

function authRequest(
  path = '/sign-in/email',
  ip: string | null = '192.0.2.10',
) {
  const headers = new Headers({
    origin: 'https://media.example',
    cookie: 'session=synthetic',
    [trustedClientIpHeader]: '198.51.100.99',
    'x-forwarded-for': '198.51.100.99',
    'x-real-ip': '198.51.100.99',
  })
  if (ip !== null) headers.set('cf-connecting-ip', ip)
  return new Request(`https://media.example/api/auth${path}`, {
    method: 'POST',
    headers,
    body: '{}',
  })
}

test('Worker overwrites spoofed IPs and proxy forwards only the verified address', async () => {
  for (const ip of ['192.0.2.10', '198.51.100.20', '2001:db8::1']) {
    const keys: string[] = []
    let received: Request | undefined
    const response = await protectCloudAuth(
      authRequest('/sign-in/email', ip),
      {
        limit: async ({ key }) => {
          keys.push(key)
          return { success: true }
        },
      },
      (request) =>
        proxyApiRequest(
          request,
          async (upstream) => {
            received = upstream
            const headers = new Headers()
            headers.append(
              'set-cookie',
              '__Secure-better-auth.session_token=one; Secure; HttpOnly; SameSite=Lax; Path=/',
            )
            headers.append('set-cookie', 'other=two; Secure; HttpOnly; Path=/')
            return new Response(null, { headers })
          },
          request.headers.get(trustedClientIpHeader),
        ),
    )
    assert.equal(response.status, 200)
    assert.deepEqual(keys, [ip])
    assert.ok(received)
    assert.equal(received.headers.get(trustedClientIpHeader), ip)
    assert.equal(received.headers.get('cf-connecting-ip'), null)
    assert.equal(received.headers.get('x-forwarded-for'), null)
    assert.equal(received.headers.get('x-real-ip'), null)
    assert.equal(received.headers.get('cookie'), 'session=synthetic')
    assert.equal(received.headers.get('origin'), 'https://media.example')
    assert.equal(await received.text(), '{}')
    assert.equal(response.headers.getSetCookie().length, 2)
    assert.match(response.headers.get('cache-control') ?? '', /no-store/)
  }
})

test('login, disabled signup and password reset share the same per-IP rate key', async () => {
  const keys: string[] = []
  for (const path of [
    '/sign-in/email',
    '/sign-up/email',
    '/request-password-reset',
    '/reset-password/token',
    '/forget-password',
    '/sign-in/email/',
    '//sign-in/email',
    '/%73ign-in/email',
  ]) {
    const response = await protectCloudAuth(
      authRequest(path),
      {
        limit: async ({ key }) => {
          keys.push(key)
          return { success: false }
        },
      },
      async () => {
        throw new Error('must not reach API')
      },
    )
    assert.equal(response.status, 429, path)
    assert.equal(response.headers.get('retry-after'), '60')
    assert.match(response.headers.get('cache-control') ?? '', /no-store/)
    assert.equal(
      response.headers.get('cloudflare-cdn-cache-control'),
      'no-store',
    )
    assert.equal((await response.text()).includes('192.0.2.10'), false)
  }
  assert.equal(keys.length, 8)
  assert.deepEqual(new Set(keys), new Set(['192.0.2.10']))
})

test('auth attempts fail closed without the binding or a valid Cloudflare IP', async () => {
  let calls = 0
  const next = async () => {
    calls += 1
    return new Response(null)
  }
  const missing = await protectCloudAuth(authRequest(), undefined, next)
  assert.equal(missing.status, 503)
  const failed = await protectCloudAuth(
    authRequest(),
    {
      limit: async () => {
        throw new Error('private infrastructure details')
      },
    },
    next,
  )
  assert.equal(failed.status, 503)
  assert.deepEqual(await failed.json(), {
    message: 'Authentication unavailable',
  })
  for (const ip of [null, '', 'invalid', '192.0.2.1, 192.0.2.2']) {
    const response = await protectCloudAuth(
      authRequest('/sign-in/email', ip),
      {
        limit: async () => {
          throw new Error('must not check an untrusted key')
        },
      },
      next,
    )
    assert.equal(response.status, 503)
  }
  assert.equal(calls, 0)
})

test('logout and SSR session checks work without a rate binding or client IP', async () => {
  for (const [path, method] of [
    ['/api/auth/sign-out', 'POST'],
    ['/api/auth/sign-out/', 'POST'],
    ['/api/auth/get-session', 'GET'],
    ['/api/auth/get-session/', 'HEAD'],
    ['/api/v1/albums', 'GET'],
  ]) {
    const request = new Request(`https://media.example${path}`, {
      method,
      headers: { [trustedClientIpHeader]: '198.51.100.99' },
    })
    const response = await protectCloudAuth(
      request,
      undefined,
      async (upstream) => {
        assert.equal(upstream.headers.get(trustedClientIpHeader), null)
        return new Response(null, { status: 204 })
      },
    )
    assert.equal(response.status, 204)
  }
})

test('malformed path escapes fail closed before invoking Next.js', async () => {
  const response = await protectCloudAuth(
    authRequest('/%ZZ'),
    undefined,
    async () => {
      throw new Error('must not reach Next.js')
    },
  )
  assert.equal(response.status, 404)
})
