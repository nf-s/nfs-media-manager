import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import dns from 'node:dns'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { DispatchExpiredError, httpsTransport, readBody } from '../dist/http.js'

function mockSocket(t) {
  const socket = new EventEmitter()
  const outgoing = new EventEmitter()
  const state = { requests: 0, sent: 0, dnsCallback: null, lookupOptions: null }
  outgoing.destroy = (error) => {
    outgoing.emit('error', error)
    return outgoing
  }
  t.mock.method(dns, 'lookup', (_hostname, _options, callback) => {
    state.dnsCallback = callback
  })
  t.mock.method(https, 'request', (_url, options, respond) => {
    state.requests++
    outgoing.end = () => {
      state.sent++
      const incoming = new PassThrough()
      incoming.statusCode = 302
      incoming.headers = {
        location: 'https://other.example',
        'content-type': 'text/plain',
      }
      respond(incoming)
      incoming.end('redirect')
    }
    queueMicrotask(() => {
      outgoing.emit('socket', socket)
      options.lookup('provider.example', { all: true }, (error, addresses) => {
        if (error) outgoing.destroy(error)
        else state.lookupOptions = addresses
      })
    })
    return outgoing
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  return { state, socket }
}

test('transport refuses literal IPs before creating a socket', async (t) => {
  const { state } = mockSocket(t)
  for (const url of [
    'https://127.0.0.1/api',
    'https://[::1]/api',
    'https://93.184.216.34/api',
  ]) {
    await assert.rejects(
      httpsTransport(url, {
        method: 'GET',
        headers: {},
        signal: new AbortController().signal,
      }),
    )
  }
  assert.equal(state.requests, 0)
})

test('transport checks permission before creating the request', async (t) => {
  const { state } = mockSocket(t)
  await assert.rejects(
    httpsTransport('https://provider.example/api', {
      method: 'GET',
      headers: {},
      signal: new AbortController().signal,
      canDispatch: () => false,
    }),
    DispatchExpiredError,
  )
  assert.equal(state.requests, 0)
})

test('DNS callback after deadline destroys request without sending', async (t) => {
  const { state } = mockSocket(t)
  let permitted = true
  const promise = httpsTransport('https://provider.example/api', {
    method: 'GET',
    headers: {},
    signal: new AbortController().signal,
    canDispatch: () => permitted,
  })
  const rejection = assert.rejects(promise, DispatchExpiredError)
  await Promise.resolve()
  permitted = false
  state.dnsCallback(null, [{ address: '93.184.216.34', family: 4 }])
  await rejection
  assert.equal(state.sent, 0)
})

test('private DNS address is refused at connection time', async (t) => {
  const { state } = mockSocket(t)
  const promise = httpsTransport('https://provider.example/api', {
    method: 'GET',
    headers: {},
    signal: new AbortController().signal,
  })
  const rejection = assert.rejects(promise, /Non-public/)
  await Promise.resolve()
  state.dnsCallback(null, [{ address: '127.0.0.1', family: 4 }])
  await rejection
  assert.equal(state.sent, 0)
})

test('TLS readiness after deadline never flushes credentials or request bytes', async (t) => {
  const { state, socket } = mockSocket(t)
  let permitted = true
  const promise = httpsTransport('https://provider.example/api', {
    method: 'GET',
    headers: { 'x-api-key': 'synthetic-secret' },
    signal: new AbortController().signal,
    canDispatch: () => permitted,
  })
  const rejection = assert.rejects(promise, DispatchExpiredError)
  await Promise.resolve()
  state.dnsCallback(null, [{ address: '93.184.216.34', family: 4 }])
  assert.equal(state.sent, 0)
  permitted = false
  socket.emit('secureConnect')
  await rejection
  assert.equal(state.sent, 0)
})

test('valid TLS connection sends exactly once and returns redirect without following it', async (t) => {
  const { state, socket } = mockSocket(t)
  const signal = new AbortController().signal
  const promise = httpsTransport('https://provider.example/api', {
    method: 'GET',
    headers: {},
    signal,
    canDispatch: () => true,
  })
  await Promise.resolve()
  state.dnsCallback(null, [{ address: '93.184.216.34', family: 4 }])
  socket.emit('secureConnect')
  const response = await promise
  assert.equal(response.status, 302)
  assert.equal(await readBody(response, 100, signal), 'redirect')
  assert.equal(state.requests, 1)
  assert.equal(state.sent, 1)
})
