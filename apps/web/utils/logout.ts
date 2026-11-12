import type { QueryClient } from '@tanstack/react-query'

export async function clearSessionData(
  queryClient: QueryClient,
  navigate: (path: string) => void,
): Promise<void> {
  try {
    await queryClient.cancelQueries()
  } finally {
    queryClient.clear()
    // A document navigation discards Next.js router caches as well as React state.
    navigate('/login')
  }
}
