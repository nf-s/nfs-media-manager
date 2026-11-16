import assert from 'node:assert/strict'
import { test } from 'node:test'
import { playerClientId, playerClientName } from './player-client'

test('a browser is named by its product and platform', () => {
  assert.equal(
    playerClientName(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    ),
    'Chrome on Mac',
  )
  assert.equal(
    playerClientName(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    ),
    'Safari on iPhone',
  )
  assert.equal(
    playerClientName(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
    ),
    'Edge on Windows',
  )
  assert.equal(
    playerClientName(
      'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
    ),
    'Firefox on Linux',
  )
  assert.equal(playerClientName(''), 'Another browser')
})

test('each load of the page gets its own client ID', () => {
  const first = playerClientId()
  assert.match(first, /^[A-Za-z0-9_-]{8,64}$/)
  assert.notEqual(first, playerClientId())
})
