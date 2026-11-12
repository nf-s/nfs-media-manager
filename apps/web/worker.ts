import handler from './.open-next/worker.js'
import { protectCloudAuth } from './utils/cloud-auth'
import {
  isForbiddenPublicPath,
  privateResponse,
} from './utils/private-response'

export default {
  async fetch(request, env, context) {
    const { pathname } = new URL(request.url)
    if (isForbiddenPublicPath(pathname)) {
      return privateResponse(new Response(null, { status: 404 }))
    }

    const response = await protectCloudAuth(
      request,
      env.AUTH_RATE_LIMITER,
      (upstream) => handler.fetch(upstream, env, context),
    )
    // Only fingerprinted build assets may opt into shared caching.
    if (pathname.startsWith('/_next/static/')) return response
    return privateResponse(response)
  },
} satisfies ExportedHandler<CloudflareEnv>
