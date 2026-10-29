import { NextResponse, type NextRequest } from 'next/server'
import { env } from '@/env'

const protectedPrefixes = [
  '/albums',
  '/films',
  '/imports',
  '/jobs',
  '/providers',
]

function isProtectedRoute(pathname: string): boolean {
  return protectedPrefixes.some((prefix) => pathname.startsWith(prefix))
}

export async function middleware(request: NextRequest) {
  let pathname: string
  try {
    pathname = new URL(
      decodeURIComponent(request.nextUrl.pathname),
      request.url,
    ).pathname
  } catch {
    return new NextResponse(null, { status: 404 })
  }
  // Legacy libraries are local import inputs, never public application assets.
  if (pathname === '/data' || pathname.startsWith('/data/')) {
    return new NextResponse(null, {
      status: 404,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
  const sessionToken =
    request.cookies.get('better-auth.session_token') ??
    request.cookies.get('__Secure-better-auth.session_token')

  if (!sessionToken && isProtectedRoute(pathname)) {
    return NextResponse.redirect(
      new URL('/login', env.INTERNAL_FRONTEND_URL ?? env.APP_URL),
    )
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)',
  ],
}
