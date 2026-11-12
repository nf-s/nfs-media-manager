import assert from 'node:assert/strict'
import test from 'node:test'
import { deployVariables } from './deploy-cloudflare.mjs'

const environment = {
  CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  CLOUDFLARE_APP_URL: 'https://media.example',
}

test('passes the public origin and optional analytics token to Wrangler', () => {
  assert.deepEqual(deployVariables(environment), [
    '--var',
    'APP_URL:https://media.example',
  ])
  assert.deepEqual(
    deployVariables({
      ...environment,
      CLOUDFLARE_WEB_ANALYTICS_TOKEN: 'abcdef0123456789abcdef0123456789',
    }),
    [
      '--var',
      'APP_URL:https://media.example',
      '--var',
      'CLOUDFLARE_WEB_ANALYTICS_TOKEN:abcdef0123456789abcdef0123456789',
    ],
  )
})

test('rejects an incomplete or unsafe deployment environment', () => {
  for (const invalid of [
    { ...environment, CLOUDFLARE_ACCOUNT_ID: undefined },
    { ...environment, CLOUDFLARE_APP_URL: undefined },
    { ...environment, CLOUDFLARE_APP_URL: 'http://media.example' },
    { ...environment, CLOUDFLARE_APP_URL: 'https://media.example/path' },
    { ...environment, CLOUDFLARE_WEB_ANALYTICS_TOKEN: 'not-a-token' },
  ])
    assert.throws(() => deployVariables(invalid))
})
