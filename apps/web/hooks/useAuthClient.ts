'use client'

import { useContext, useMemo } from 'react'
import { ConfigContext } from '@/components/providers'
import { createAuthClient } from '@/utils/authClient'

export function useAuthClient() {
  const { apiBaseUrl } = useContext(ConfigContext)

  return useMemo(() => createAuthClient(apiBaseUrl), [apiBaseUrl])
}
