import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBuildEnvironment, readBuildAppUrl } from './build-cloudflare.mjs'

test('build reads JSONC comments and formatter-added trailing commas', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'media-build-config-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const config = join(directory, 'wrangler.jsonc')
  await mkdir(join(directory, 'public'))
  await writeFile(
    config,
    `{
    // Deployment origin, not an API URL.
    "name": "synthetic-web",
    "compatibility_date": "2026-10-30",
    "vars": { "APP_URL": "https://media.example", },
  }`,
  )
  assert.equal(readBuildAppUrl(config), 'https://media.example')
  assert.equal(
    readBuildAppUrl(config, 'https://override.example'),
    'https://override.example',
  )
  assert.throws(
    () => readBuildAppUrl(config, 'http://localhost:3000'),
    /HTTPS URL/,
  )
})

test('staged builds do not inherit local application configuration or secrets', () => {
  const environment = createBuildEnvironment(
    '/stage/apps/web',
    'https://media.example',
    {
      PATH: '/bin',
      HOME: '/home/test',
      NODE_ENV: 'development',
      WEB_RUNTIME: 'node',
      APP_URL: 'http://localhost:3001',
      INTERNAL_FRONTEND_URL: 'http://localhost:3001',
      INTERNAL_BACKEND_URL: 'http://localhost:4001',
      DATABASE_URL: 'synthetic-private',
      BETTER_AUTH_SECRET: 'synthetic-private',
      NEXT_PUBLIC_PRIVATE: 'synthetic-private',
    },
  )
  assert.equal(environment.APP_URL, 'https://media.example')
  assert.equal(environment.NODE_ENV, 'production')
  assert.equal(environment.WEB_RUNTIME, 'cloudflare')
  assert.equal(environment.HOME, '/home/test')
  for (const key of [
    'INTERNAL_FRONTEND_URL',
    'INTERNAL_BACKEND_URL',
    'DATABASE_URL',
    'BETTER_AUTH_SECRET',
    'NEXT_PUBLIC_PRIVATE',
  ]) {
    assert.equal(key in environment, false, key)
  }
})
