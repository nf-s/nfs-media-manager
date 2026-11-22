// The preview API: the app without the job worker, so nothing a click queues
// is ever run, plus a local sign-in link for the generated preview account.
import { serve } from '@hono/node-server'
import app from '@/app'
import { env } from '@/env'
import { db } from '@/lib/db'
import { assertPreviewDatabase } from './preview-database'

assertPreviewDatabase(env)

const signInPath = '/preview/sign-in'

/**
 * Signs the preview account in server-side and hands the session cookie to
 * the browser, so the generated password is never typed or shown. Cookies are
 * per host, so the cookie set here is sent to the web app's port too.
 */
async function signIn(request: Request): Promise<Response> {
  const email = process.env.INITIAL_USER_EMAIL
  const password = process.env.INITIAL_USER_PASSWORD
  if (!email || !password)
    return new Response('Preview account settings are missing', {
      status: 500,
    })
  const requested = new URL(request.url).searchParams.get('next') ?? '/'
  const next =
    requested.startsWith('/') && !requested.startsWith('//') ? requested : '/'
  const response = await app.fetch(
    new Request(new URL('/api/auth/sign-in/email', request.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: env.APP_URL },
      body: JSON.stringify({ email, password }),
    }),
  )
  const cookies = response.headers.getSetCookie()
  if (!response.ok || !cookies.length)
    return new Response(`Preview sign-in failed (HTTP ${response.status})`, {
      status: 502,
    })
  const headers = new Headers({
    Location: new URL(next, env.APP_URL).href,
    'Cache-Control': 'no-store',
  })
  for (const cookie of cookies) headers.append('Set-Cookie', cookie)
  return new Response(null, { status: 302, headers })
}

const server = serve(
  {
    hostname: '127.0.0.1',
    port: env.PORT,
    fetch: (request) =>
      request.method === 'GET' && new URL(request.url).pathname === signInPath
        ? signIn(request)
        : app.fetch(request),
  },
  () => {
    console.info(`Preview API on http://127.0.0.1:${env.PORT}`)
  },
)

function shutdown(): void {
  server.close(() => {
    void db.$client.end().finally(() => process.exit(0))
  })
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
