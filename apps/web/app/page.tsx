import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { hasSessionToken } from '@/utils/session-cookie'

export default async function HomePage() {
  // The destination's admin layout validates the session with the API.
  redirect(hasSessionToken(await cookies()) ? '/albums' : '/login')
}
