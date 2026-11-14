'use client'

import { createContext, useContext, useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import {
  FileImportFormatSchema,
  ImportStatusSchema,
} from '@repo/schemas/imports'
import { useConfig } from './providers'
import { SectionSidebar, SectionWorkspace } from './section-sidebar'
import { fetchApiData } from '@/utils/api'
import { useLibraryView, useMediaScope } from './media-scope'
import { scopedHref } from '@/utils/media-scope'
import {
  albumImportDestinations,
  csvImportHref,
  importDestinations,
  resolveCsvFormat,
  subscriptionImportDestinations,
  trackImportDestinations,
} from '@/utils/import-navigation'

function useImportsData(enabled = true) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const status = useQuery({
    queryKey: ['imports'],
    enabled,
    queryFn: () =>
      fetchApiData(apiBaseUrl, '/api/v1/imports', ImportStatusSchema),
    staleTime: 0,
    refetchInterval: 2000,
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
    staleTime: 0,
  })
  const running =
    status.data?.runs.some(
      (run) => run.status === 'running' || run.status === 'queued',
    ) ?? false
  const completed =
    status.data?.runs
      .filter((run) => run.finishedAt)
      .map((run) => `${run.id}:${run.status}`)
      .join(',') ?? ''
  useEffect(() => {
    if (enabled && completed)
      void client.invalidateQueries({
        predicate: (query) =>
          [
            'albums',
            'films',
            'album',
            'film',
            'history',
            'jobs',
            'job-activity',
          ].includes(String(query.queryKey[0])),
      })
  }, [enabled, completed, client])
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
  if (status.isError)
    return (
      <p role="alert">
        Could not load imports.{' '}
        <button onClick={() => status.refetch()}>Retry</button>
      </p>
    )
  if (status.isPending)
    return (
      <p role="status" className="muted">
        Loading imports...
      </p>
    )
  if (running)
    return (
      <p role="status" className="muted">
        {activeRun?.mediaType === 'film'
          ? 'A film import is in progress.'
          : activeRun?.mediaType === 'album'
            ? 'An album import is in progress.'
            : 'An import is in progress.'}{' '}
        <Link href={scopedHref('/imports', activeRun?.mediaType ?? mediaType)}>
          Follow it in Recent imports
        </Link>
        .
      </p>
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
