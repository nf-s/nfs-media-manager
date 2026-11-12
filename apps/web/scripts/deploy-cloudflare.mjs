import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Deployment-specific Worker variables come from the caller's environment so
 * no account, origin or analytics token is stored in the repository.
 */
export function deployVariables(environment) {
  if (!/^[a-f0-9]{32}$/.test(environment.CLOUDFLARE_ACCOUNT_ID ?? '')) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID is required')
  }
  const origin = new URL(environment.CLOUDFLARE_APP_URL ?? '')
  if (origin.protocol !== 'https:' || origin.pathname !== '/') {
    throw new Error('CLOUDFLARE_APP_URL must be an HTTPS origin')
  }
  const token = environment.CLOUDFLARE_WEB_ANALYTICS_TOKEN
  if (token !== undefined && !/^[a-f0-9]{32}$/.test(token)) {
    throw new Error('CLOUDFLARE_WEB_ANALYTICS_TOKEN is invalid')
  }
  return [
    '--var',
    `APP_URL:${origin.origin}`,
    ...(token ? ['--var', `CLOUDFLARE_WEB_ANALYTICS_TOKEN:${token}`] : []),
  ]
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // Wrangler reads CLOUDFLARE_ACCOUNT_ID itself; extra arguments pass through.
  const child = spawn(
    'wrangler',
    ['deploy', ...deployVariables(process.env), ...process.argv.slice(2)],
    { stdio: 'inherit' },
  )
  child.once('error', () => {
    process.stderr.write('Wrangler could not be started.\n')
    process.exitCode = 1
  })
  child.once('exit', (code) => {
    process.exitCode = code ?? 1
  })
}
