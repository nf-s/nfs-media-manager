import { spawn } from 'node:child_process'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unstable_readConfig } from 'wrangler'
import { buildInCleanWorkspace } from './stage-cloudflare-build.mjs'

export function readBuildAppUrl(configPath, override) {
  const config = unstable_readConfig({ config: configPath })
  const appUrl = override ?? config.vars.APP_URL
  if (typeof appUrl !== 'string' || new URL(appUrl).protocol !== 'https:') {
    throw new Error('Cloudflare APP_URL must be an HTTPS URL')
  }
  return appUrl
}

export function createBuildEnvironment(stagedApp, appUrl, environment) {
  const toolVariables = new Set([
    'PATH',
    'HOME',
    'USERPROFILE',
    'SystemRoot',
    'SYSTEMROOT',
    'ComSpec',
    'COMSPEC',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'PNPM_HOME',
    'CI',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ])
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(([key]) => toolVariables.has(key)),
    ),
    PATH: [
      join(stagedApp, 'node_modules/.bin'),
      join(stagedApp, '../../node_modules/.bin'),
      environment.PATH ?? '',
    ].join(delimiter),
    NODE_ENV: 'production',
    WEB_RUNTIME: 'cloudflare',
    APP_URL: appUrl,
    NEXT_TELEMETRY_DISABLED: '1',
  }
}

async function main() {
  const appDirectory = fileURLToPath(new URL('..', import.meta.url))
  const appUrl = readBuildAppUrl(
    join(appDirectory, 'wrangler.jsonc'),
    process.env.CLOUDFLARE_APP_URL,
  )
  process.stdout.write('Preparing isolated Cloudflare build workspace.\n')
  await buildInCleanWorkspace(appDirectory, async (stagedApp) => {
    const child = spawn(
      process.execPath,
      [
        join(
          stagedApp,
          'node_modules/@opennextjs/cloudflare/dist/cli/index.js',
        ),
        'build',
      ],
      {
        cwd: stagedApp,
        stdio: 'inherit',
        env: createBuildEnvironment(stagedApp, appUrl, process.env),
      },
    )

    const onInterrupt = () => child.kill('SIGINT')
    const onTerminate = () => child.kill('SIGTERM')
    process.on('SIGINT', onInterrupt)
    process.on('SIGTERM', onTerminate)
    try {
      const exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code) => resolve(code ?? 1))
      })
      if (exitCode !== 0)
        throw new Error(`OpenNext build failed with exit code ${exitCode}`)
    } finally {
      process.off('SIGINT', onInterrupt)
      process.off('SIGTERM', onTerminate)
    }
  })
  process.stdout.write(
    'Verified Cloudflare output written to apps/web/.open-next.\n',
  )
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main()
}
