export function privateResponse(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'private, no-store, max-age=0')
  headers.set('CDN-Cache-Control', 'no-store')
  headers.set('Cloudflare-CDN-Cache-Control', 'no-store')

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export function isForbiddenPublicPath(pathname: string): boolean {
  try {
    const decoded = decodeURIComponent(pathname)
      .replaceAll('\\', '/')
      .replace(/^\/+/, '/')
    const normalized = new URL(decoded, 'https://assets.invalid').pathname
    return (
      normalized === '/data' ||
      normalized.startsWith('/data/') ||
      normalized === '/config.json' ||
      normalized.endsWith('.map')
    )
  } catch {
    return true
  }
}
