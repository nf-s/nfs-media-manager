import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spotifyCallbackSetup } from './spotify-setup'

test('local callback keeps the API port without moving the signed-in browser', () => {
  assert.deepEqual(
    spotifyCallbackSetup(
      'http://localhost:4001',
      'http://localhost:3001',
      null,
    ),
    {
      callbackUrl: 'http://127.0.0.1:4001/api/v1/spotify/callback',
    },
  )
})

test('configured HTTPS callback remains exact and does not guess a frontend on another hostname', () => {
  const setup = spotifyCallbackSetup(
    'https://api.example.test',
    'https://web.example.test',
    'https://api.example.test/api/v1/spotify/callback',
  )
  assert.equal(
    setup?.callbackUrl,
    'https://api.example.test/api/v1/spotify/callback',
  )
})

test('unusable configuration never invents a callback or recommends non-loopback HTTP', () => {
  assert.equal(spotifyCallbackSetup('', '', null), null)
  assert.equal(
    spotifyCallbackSetup(
      'http://api.example.test',
      'http://web.example.test',
      null,
    ),
    null,
  )
  assert.equal(
    spotifyCallbackSetup(
      'http://user:secret@localhost:4001',
      'http://localhost:3001',
      null,
    ),
    null,
  )
})
