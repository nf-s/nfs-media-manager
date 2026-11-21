import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestHarness, unstable_readConfig } from 'wrangler'

async function main() {
  const bundle = process.argv[2]
    ? resolve(process.argv[2])
    : fileURLToPath(
        new URL('../../../.cloudflare/server-build/worker.js', import.meta.url),
      )
  const { compatibility_date, compatibility_flags } = unstable_readConfig({
    config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)),
  })
  const origin = 'https://app.example.invalid'
  const harness = createTestHarness({
    root: dirname(bundle),
    workers: [
      {
        config: {
          name: 'media-api-build-check',
          main: bundle,
          no_bundle: true,
          compatibility_date,
          compatibility_flags,
          vars: {
            NODE_ENV: 'production',
            RUNTIME_KIND: 'cloudflare',
            OWNER_EMAIL: 'owner@example.invalid',
            APP_URL: origin,
            AUTH_BASE_URL: origin,
            TRUSTED_ORIGINS: origin,
            // The healthcheck does not connect to the database.
            DATABASE_URL: 'postgresql://fixture@fixture.invalid.neon.tech/test',
            BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
            MEDIA_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
          },
        },
      },
    ],
  })

  const fetch = globalThis.fetch
  // The harness dispatches directly to workerd and uses global fetch for
  // outbound requests from the Worker.
  globalThis.fetch = async () => {
    throw new Error('Outbound requests are disabled for the Worker build check')
  }
  try {
    await harness.listen()
    const response = await harness.fetch(`${origin}/api/v1/healthcheck`, {
      signal: AbortSignal.timeout(5_000),
    })
    assert.equal(response.status, 200, 'Packaged API Worker healthcheck status')
    assert.deepEqual(await response.json(), {
      statusCode: 200,
      message: 'OK',
      data: { message: 'OK' },
    })
  } finally {
    globalThis.fetch = fetch
    await harness.close()
  }
}

void main().then(
  () => process.stdout.write('Packaged API Worker healthcheck passed.\n'),
  (error: unknown) => {
    process.stderr.write(
      `Packaged API Worker check failed. ${error instanceof Error ? error.message : ''}\n`,
    )
    process.exitCode = 1
  },
)
