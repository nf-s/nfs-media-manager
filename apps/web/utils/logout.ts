import type { QueryClient } from '@tanstack/react-query'
import { clearDeviceStore } from './device-store/bootstrap'

export async function clearSessionData(
  queryClient: QueryClient,
  navigate: (path: string) => void,
): Promise<void> {
  try {
    await queryClient.cancelQueries()
  } finally {
    queryClient.clear()
    await clearDeviceStore()
    // A document navigation discards Next.js router caches as well as React state.
    navigate('/login')
  }
}
