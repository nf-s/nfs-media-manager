'use client'

import { toast, Toaster } from '@repo/ui/components/ui/sonner'
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { createContext, useContext } from 'react'

type ServerErrorLike = {
  statusCode: number
  message: string
  description?: string | null
}

type BetterAuthErrorLike = Error & {
  error: {
    message: string
  }
}

function isServerErrorLike(value: unknown): value is ServerErrorLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'statusCode' in value &&
    typeof value.statusCode === 'number' &&
    'message' in value &&
    typeof value.message === 'string'
  )
}

function isBetterAuthErrorLike(value: Error): value is BetterAuthErrorLike {
  return (
    'error' in value &&
    typeof value.error === 'object' &&
    value.error !== null &&
    'message' in value.error &&
    typeof value.error.message === 'string'
  )
}

function isMessageOnlyObject(value: unknown): value is { message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof value.message === 'string'
  )
}

function handleError(data: unknown): void {
  if (isServerErrorLike(data)) {
    toast.error(data.message, {
      description: data.description ?? undefined,
    })
    return
  }

  if (data instanceof Error) {
    if (isBetterAuthErrorLike(data)) {
      toast.error(data.message, {
        description: data.error.message,
      })
      return
    }

    toast.error(data.message, {
      description: data.cause?.toString() ?? 'Unknown error',
    })
  }

  if (typeof data === 'string') {
    toast.error(data)
    return
  }

  if (isMessageOnlyObject(data)) {
    toast.error(data.message)
  }
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 24 * 60 * 60 * 1000, // stale time 24 hours
    },
  },
  queryCache: new QueryCache({
    onError: handleError,
  }),
  mutationCache: new MutationCache({
    onError: handleError,
  }),
})

export const ConfigContext = createContext<{
  appUrl: string
  apiBaseUrl: string
}>({
  appUrl: '',
  apiBaseUrl: '',
})

export const useConfig = () => {
  return useContext(ConfigContext)
}

interface Props {
  children?: React.ReactNode
  appUrl: string
  apiBaseUrl: string
}

const Providers: React.FC<Props> = ({ children, appUrl, apiBaseUrl }) => {
  return (
    <ConfigContext.Provider value={{ appUrl, apiBaseUrl }}>
      <QueryClientProvider client={queryClient}>
        {children}
        <Toaster />
      </QueryClientProvider>
    </ConfigContext.Provider>
  )
}

export default Providers
