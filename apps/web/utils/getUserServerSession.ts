import { cookies, headers } from 'next/headers'
import { env } from '@/env'
import { createAuthClient } from '@/utils/authClient'

export async function getUserServerSession(): Promise<{
  user: {
    id: string
    email: string
    name: string
    role?: string | null
  } | null
  session: {
    id: string
    userId: string
  } | null
}> {
  const cookieStore = await cookies()
  const headersList = await headers()

  try {
    const response = await createAuthClient(
      env.INTERNAL_BACKEND_URL ?? env.APP_URL,
    ).getSession({
      fetchOptions: {
        throw: false,
        headers: {
          cookie: cookieStore.toString(),
          'x-forwarded-for': headersList.get('x-forwarded-for') ?? '',
          'x-real-ip': headersList.get('x-real-ip') ?? '',
        },
      },
    })

    return {
      user: response.data?.user ?? null,
      session: response.data?.session ?? null,
    }
  } catch {
    return {
      user: null,
      session: null,
    }
  }
}
