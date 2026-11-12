import { z } from 'zod'
import { privateResponse } from './private-response'

type ApiFetch = (request: Request) => Promise<Response>
export const trustedClientIpHeader = 'x-media-client-ip'
const clientIpSchema = z.union([z.ipv4(), z.ipv6()])

export function readClientIp(value: string | null | undefined): string | null {
  const parsed = clientIpSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function createNodeApiRequest(request: Request, backend: URL): Request {
  const target = new URL(request.url)
  target.protocol = backend.protocol
  target.host = backend.host
  const upstream = new Request(target, request)
  // Node fetch decompresses bodies but retains upstream encoding/length headers.
  upstream.headers.set('accept-encoding', 'identity')
  return upstream
}

export async function proxyApiRequest(
  request: Request,
  fetchApi: ApiFetch,
  trustedClientIp?: string | null,
): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
    return privateResponse(new Response(null, { status: 404 }))
  }

  const headers = new Headers(request.headers)
  for (const name of [
    'host',
    'connection',
    'forwarded',
    'x-forwarded-for',
    'x-real-ip',
    'cf-connecting-ip',
    'cf-connecting-ipv6',
    'true-client-ip',
    trustedClientIpHeader,
    'x-forwarded-host',
    'x-forwarded-proto',
  ]) {
    headers.delete(name)
  }
  headers.set('x-forwarded-host', url.host)
  headers.set('x-forwarded-proto', url.protocol.slice(0, -1))
  const clientIp = readClientIp(trustedClientIp)
  if (clientIp) headers.set(trustedClientIpHeader, clientIp)

  try {
    // Keep the public URL/Origin for auth, but never follow redirects with cookies.
    const upstream = await fetchApi(
      new Request(request, { headers, redirect: 'manual' }),
    )
    return privateResponse(upstream)
  } catch {
    return privateResponse(
      Response.json({ message: 'API unavailable' }, { status: 502 }),
    )
  }
}
