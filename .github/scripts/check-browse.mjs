// Signed-in production check: opens Tracks Browse in the table view with a
// dedicated owner session and measures the time from navigation start to the
// first visible track row. Fails over the limit or when the session is refused.
import { createRequire } from 'node:module'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const limitMs = 10_000
const path = '/tracks?view=table'

function fail(message) {
  process.stderr.write(`::error::${message}\n`)
  process.exit(1)
}

const modules = process.env.BROWSE_CHECK_MODULES
const token = process.env.BROWSE_CHECK_SESSION_TOKEN
if (!modules || !token) fail('The signed-in Browse check is not configured.')

let origin
try {
  const url = new URL(process.env.CLOUDFLARE_APP_URL ?? '')
  if (url.href !== `${url.origin}/`) throw new Error('not an origin')
  origin = url.origin
} catch {
  fail('Configure the Cloudflare app origin.')
}

const { chromium } = createRequire(join(modules, 'package.json'))(
  'playwright-core',
)

let result
let failure
const browser = await chromium
  .launch({ channel: 'chrome', headless: true })
  .catch(() => fail('Could not start Chrome for the signed-in Browse check.'))
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })
  await context.addCookies([
    {
      name: `${origin.startsWith('https:') ? '__Secure-' : ''}better-auth.session_token`,
      value: token,
      url: origin,
      httpOnly: true,
      secure: origin.startsWith('https:'),
      sameSite: 'Lax',
    },
  ])
  const page = await context.newPage()
  await page.goto(`${origin}${path}`, {
    waitUntil: 'commit',
    timeout: limitMs * 3,
  })
  const handle = await page.waitForFunction(
    () => {
      if (location.pathname.startsWith('/login')) return { signedOut: true }
      const visible = Array.from(
        document.querySelectorAll('tbody tr:not([aria-hidden="true"])'),
      ).some((row) => {
        const box = row.getBoundingClientRect()
        return (
          box.height > 0 &&
          box.bottom > 0 &&
          box.top < window.innerHeight &&
          (row.textContent ?? '').trim() !== ''
        )
      })
      return visible ? { ms: Math.round(performance.now()) } : null
    },
    null,
    { polling: 'raf', timeout: limitMs * 3 },
  )
  result = await handle.jsonValue()
} catch (error) {
  // Report only the error class: messages can echo request details.
  const name = error instanceof Error ? error.name : 'Error'
  failure = `Tracks Browse showed no rows within ${(limitMs * 3) / 1000} s (${name}).`
} finally {
  await browser.close().catch(() => undefined)
}
if (failure) fail(failure)

if (result.signedOut)
  fail(
    'Production refused the Browse check session. Replace the BROWSE_CHECK_SESSION_TOKEN secret.',
  )

const line = `Tracks Browse showed its first rows ${result.ms} ms after navigation start (limit ${limitMs} ms).`
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`)
if (result.ms > limitMs) fail(line)
process.stdout.write(`${line}\n`)
