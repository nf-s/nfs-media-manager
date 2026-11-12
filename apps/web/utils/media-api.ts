import { getCloudflareContext } from '@opennextjs/cloudflare'
import { env } from '@/env'
import {
  createNodeApiRequest,
  proxyApiRequest,
  trustedClientIpHeader,
} from './api-proxy'

export async function fetchMediaApi(request: Request): Promise<Response> {
  if (env.WEB_RUNTIME === 'cloudflare') {
    const { env: bindings } = await getCloudflareContext({ async: true })
    return proxyApiRequest(
      request,
      (upstream) => bindings.MEDIA_API.fetch(upstream),
      // The public Worker overwrites this header before invoking Next.js.
      request.headers.get(trustedClientIpHeader),
    )
  }

  if (!env.INTERNAL_BACKEND_URL) {
    return proxyApiRequest(request, async () => {
      throw new Error('INTERNAL_BACKEND_URL is required for the Node API proxy')
    })
  }

  const backend = new URL(env.INTERNAL_BACKEND_URL)
  return proxyApiRequest(request, (upstream) =>
    fetch(createNodeApiRequest(upstream, backend), { cache: 'no-store' }),
  )
}
