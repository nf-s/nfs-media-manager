import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NextRequest } from 'next/server'
import { middleware } from '../middleware'
import { hasSessionToken } from './session-cookie'

function request(path: string, cookie = '') {
  return new NextRequest(new URL(path, 'https://media.example'), {
    headers: { cookie },
  })
}

test('a guest or a session-data cookie alone has no session token hint', () => {
  for (const cookie of ['', 'better-auth.session_data=fixture']) {
    assert.equal(hasSessionToken(request('/', cookie).cookies), false)
  }
})

test('local and secure session tokens both provide the same routing hint', () => {
  for (const cookie of [
    'better-auth.session_token=fixture',
    '__Secure-better-auth.session_token=fixture',
  ]) {
    assert.equal(hasSessionToken(request('/', cookie).cookies), true)
  }
})

test('a stale cookie reaches the authoritative Albums guard', async () => {
  const response = await middleware(
    request('/albums', '__Secure-better-auth.session_token=fixture-expired'),
  )
  assert.equal(response.headers.get('x-middleware-next'), '1')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
})
