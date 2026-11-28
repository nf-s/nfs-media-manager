'use client'

import { toast, Toaster } from '@repo/ui/components/ui/sonner'
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { usePathname } from 'next/navigation'
import { createContext, useContext, useLayoutEffect } from 'react'
import type { LibraryActionKind } from '@repo/ui/components/ds/library-action'
import { observeDocumentBrowsePath } from '@/hooks/useBrowsePerformance'
import { clientQueryDefaults } from '@/utils/query-cache'
import { initializeKeyNotation } from '@/utils/key-notation'
import { startDeviceStore } from '@/utils/device-store/bootstrap'

initializeKeyNotation()

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
  const message =
    typeof data === 'string'
      ? data
      : isMessageOnlyObject(data)
        ? data.message
        : undefined
  if (!message) return
  const detail = isServerErrorLike(data)
    ? data.description
    : data instanceof Error
      ? isBetterAuthErrorLike(data)
        ? data.error.message
        : data.cause?.toString()
      : undefined
  const description = detail && detail !== message ? detail : undefined
  const notify = () =>
    toast.error(message, {
      description,
      id: JSON.stringify([message, description]),
    })
  if (typeof window === 'undefined') {
    notify()
    return
  }
  // The cache reports the error before the component renders its alert.
  window.setTimeout(
    () =>
      window.requestAnimationFrame(() => {
        for (const alert of document.querySelectorAll<HTMLElement>(
          '[role="alert"]',
        )) {
          if (!alert.checkVisibility() || alert.closest('[data-sonner-toast]'))
            continue
          const text = alert.innerText
          if (
            text.includes(message) &&
            (!description || text.includes(description))
          )
            return
        }
        notify()
      }),
    0,
  )
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: clientQueryDefaults,
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

type AnnounceLibraryAddition = (
  kind: LibraryActionKind,
  title: string,
  receiptId?: string,
) => void
const LibraryAnnouncementContext = createContext<AnnounceLibraryAddition>(
  () => {},
)
export const useAnnounceLibraryAddition = () =>
  useContext(LibraryAnnouncementContext)

function BrowseDocumentTiming() {
  const pathname = usePathname()
  useLayoutEffect(() => {
    if (pathname) observeDocumentBrowsePath()
  }, [pathname])
  return null
}

/** Layout effects run before any query subscribes, so the first Browse read can use the copy. */
function DeviceStore({ apiBaseUrl }: { apiBaseUrl: string }) {
  useLayoutEffect(
    () => startDeviceStore({ apiBaseUrl, client: queryClient }),
    [apiBaseUrl],
  )
  return null
}

const Providers: React.FC<Props> = ({ children, appUrl, apiBaseUrl }) => {
  return (
    <ConfigContext.Provider value={{ appUrl, apiBaseUrl }}>
      <QueryClientProvider client={queryClient}>
        <DeviceStore apiBaseUrl={apiBaseUrl} />
        <BrowseDocumentTiming />
        <LibraryAnnouncementContext.Provider
          value={(kind, title, receiptId) => {
            const message = `Added ${kind} to library · ${title}`
            const announce = () => toast.success(message, { id: message })
            if (!receiptId) {
              announce()
              return
            }
            // The mutation cache and its Add buttons render before deciding whether a toast is needed.
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                const visibleReceipt = [
                  ...document.querySelectorAll<HTMLButtonElement>(
                    '[data-library-receipt]',
                  ),
                ].some(
                  (button) =>
                    button.dataset.libraryReceipt === receiptId &&
                    button.getClientRects().length > 0 &&
                    getComputedStyle(button).visibility === 'visible',
                )
                if (!visibleReceipt) announce()
              })
            })
          }}
        >
          {children}
        </LibraryAnnouncementContext.Provider>
        <Toaster />
      </QueryClientProvider>
    </ConfigContext.Provider>
  )
}

export default Providers
