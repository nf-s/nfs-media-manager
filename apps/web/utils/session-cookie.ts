export function hasSessionToken(cookies: { has(name: string): boolean }) {
  return (
    cookies.has('better-auth.session_token') ||
    cookies.has('__Secure-better-auth.session_token')
  )
}
