'use client'

import { ReadButton } from '@/components/read-button'
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import {
  FileImportFormatSchema,
  ImportStatusSchema,
  type ImportRun,
} from '@repo/schemas/imports'
import { Notice } from '@repo/ui/components/ds/feedback'
import { formatCount } from '@repo/ui/lib/format'
import { useConfig } from './providers'
import { SectionSidebar, SectionWorkspace } from './section-sidebar'
import { fetchApiData } from '@/utils/api'
import {
  hasNewlyCompletedImports,
  importIdlePollMs,
  importPollInterval,
  invalidateImportedLibrary,
} from '@/utils/import-cache'
import { useLibraryView, useMediaScope } from './media-scope'
import { scopedHref } from '@/utils/media-scope'
import {
  albumImportDestinations,
  csvImportHref,
  importDestinations,
  mixImportDestinations,
  resolveCsvFormat,
  subscriptionImportDestinations,
  trackImportDestinations,
} from '@/utils/import-navigation'

function useImportsData(enabled = true) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const previousRuns = useRef<ImportRun[]>(
    client.getQueryData<z.infer<typeof ImportStatusSchema>>(['imports'])
      ?.runs ?? [],
  )
  const status = useQuery({
    queryKey: ['imports'],
    enabled,
    queryFn: () =>
      fetchApiData(apiBaseUrl, '/api/v1/imports', ImportStatusSchema),
    staleTime: importIdlePollMs,
    refetchInterval: (query) => importPollInterval(query.state.data?.runs),
  })
  const formats = useQuery({
    queryKey: ['import-formats'],
    enabled,
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/imports/formats',
        z.array(FileImportFormatSchema),
      ),
  })
  const running =
    status.data?.runs.some(
      (run) => run.status === 'running' || run.status === 'queued',
    ) ?? false
  useEffect(() => {
    if (!enabled || !status.data) return
    const changed = hasNewlyCompletedImports(
      previousRuns.current,
      status.data.runs,
    )
    previousRuns.current = status.data.runs
    if (changed) void invalidateImportedLibrary(client)
  }, [enabled, status.data, client])
  return { status, formats, running }
}

const ImportsContext = createContext<ReturnType<typeof useImportsData> | null>(
  null,
)

export function useImportsWorkspace() {
  const value = useContext(ImportsContext)
  if (!value) throw new Error('Imports pages must be inside ImportsWorkspace')
  return value
}

export function ImportStatusNotice() {
  const { status, running } = useImportsWorkspace()
  const mediaType = useMediaScope()
  const view = useLibraryView()
  const activeRun = status.data?.runs.find(
    (run) => run.status === 'running' || run.status === 'queued',
  )
  if (view === 'track') return null
  if (status.isError && !status.data)
    return (
      <Notice
        tone="danger"
        action={
          <ReadButton size="xs" read={() => status.refetch()}>
            Retry
          </ReadButton>
        }
      >
        Could not load imports.
      </Notice>
    )
  if (running)
    return (
      <Notice>
        {activeRun?.mediaType === 'film'
          ? 'A film import is in progress.'
          : activeRun?.mediaType === 'album'
            ? 'An album import is in progress.'
            : 'An import is in progress.'}{' '}
        {activeRun?.total
          ? `${formatCount(activeRun.processed)} of ${formatCount(activeRun.total)} processed. `
          : ''}
        <Link href={scopedHref('/imports', activeRun?.mediaType ?? mediaType)}>
          Follow it in Recent imports
        </Link>
        .
      </Notice>
    )
  return null
}

export default function ImportsWorkspace({
  children,
}: {
  children: ReactNode
}) {
  const mediaType = useLibraryView()
  const data = useImportsData(mediaType !== 'track')
  const path = usePathname()
  const params = useSearchParams()
  const format = resolveCsvFormat(data.formats.data ?? [], params.get('format'))
  const activeId =
    path === '/imports/csv' && mediaType === 'album'
      ? '/imports/albums'
      : path === '/imports/csv' && format
        ? csvImportHref(format.id)
        : path
  return (
    <ImportsContext.Provider value={data}>
      <SectionWorkspace
        key={mediaType}
        sidebar={
          <div className="min-h-0 overflow-auto">
            <SectionSidebar
              label="Imports navigation"
              items={(mediaType === 'album'
                ? albumImportDestinations()
                : mediaType === 'track'
                  ? trackImportDestinations()
                  : mediaType === 'subscription'
                    ? subscriptionImportDestinations()
                    : mediaType === 'mix'
                      ? mixImportDestinations()
                      : importDestinations(data.formats.data ?? [])
              ).map((item) => ({
                ...item,
                href: scopedHref(item.href, mediaType),
              }))}
              activeId={activeId}
            />
          </div>
        }
      >
        {children}
      </SectionWorkspace>
    </ImportsContext.Provider>
  )
}
