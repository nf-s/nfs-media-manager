'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ImportRunSchema } from '@repo/schemas/imports'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { Status } from '@repo/ui/components/ds/status'
import { PageHead } from '@repo/ui/components/ds/toolbar'
import { EMPTY_VALUE, formatDate } from '@repo/ui/lib/format'
import { SecondaryCell, SecondaryDataTable } from '../secondary-table'
import { ConfirmAction } from '../confirm-action'
import { useConfig } from '@/components/providers'
import {
  ImportStatusNotice,
  useImportsWorkspace,
} from '@/components/imports-workspace'
import { fetchApiData } from '@/utils/api'
import { useMediaScope } from '@/components/media-scope'
import { scopedHref } from '@/utils/media-scope'

export default function LegacyImportPageClient() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const router = useRouter()
  const mediaType = useMediaScope()
  const { status: query, running } = useImportsWorkspace()
  const [fullLibrary, setFullLibrary] = useState(false)
  const start = useMutation({
    mutationFn: () =>
      fetchApiData(apiBaseUrl, '/api/v1/imports', ImportRunSchema, {
        method: 'POST',
        body: JSON.stringify({ fullLibrary, albumLimit: 2, filmLimit: 2 }),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['imports'] })
      await client.invalidateQueries({ queryKey: ['job-activity'] })
      router.push(scopedHref('/imports', mediaType))
    },
  })
  return (
    <section className="sec-page">
      <PageHead
        title="Legacy JSON library"
        note="Mixed album and film library import, shared between both scopes. Imports local library data only. No metadata scraping."
        actions={
          <>
            <label className="ds-checkrow">
              <input
                type="checkbox"
                className="ds-check"
                checked={fullLibrary}
                disabled={running || start.isPending}
                onChange={(event) => setFullLibrary(event.target.checked)}
              />
              Import all local records
            </label>
            <ConfirmAction
              variant="primary"
              confirm={fullLibrary}
              question="Import full library?"
              details="Imports every local album and film record. No metadata scraping."
              confirmLabel="Import"
              disabled={
                running ||
                start.isPending ||
                query.isPending ||
                query.isError ||
                !query.data?.sources.length ||
                !query.data.sources.every((source) => source.available)
              }
              onConfirm={() => start.mutate()}
            >
              {start.isPending
                ? 'Starting...'
                : fullLibrary
                  ? 'Import full library'
                  : 'Test import: 2 albums + 2 films'}
            </ConfirmAction>
          </>
        }
      />
      <div className="sec-notices">
        <ImportStatusNotice />
        {start.isError && <Notice tone="danger">{start.error.message}</Notice>}
      </div>
      <SecondaryDataTable
        id="legacy-import-sources"
        label="Legacy import sources"
        rows={query.data?.sources ?? []}
        rowKey={(source) => source.name}
        defaultSort={{ key: 'name', direction: 'asc' }}
        error={query.isError}
        busy={query.isFetching}
        empty={
          query.isPending ? (
            <Skeleton width="40%" height={12} />
          ) : query.isError ? (
            'Could not load sources.'
          ) : (
            'No import sources.'
          )
        }
        columns={[
          {
            key: 'name',
            label: 'Source',
            sticky: 0,
            stickyEdge: true,
            value: (source) => source.name,
          },
          {
            key: 'updated',
            label: 'Updated',
            value: (source) =>
              source.updatedAt ? Date.parse(source.updatedAt) : null,
            render: (source) =>
              source.available ? (
                <SecondaryCell text={source.updatedAt ?? undefined}>
                  {formatDate(source.updatedAt)}
                </SecondaryCell>
              ) : (
                <Status state="attention">Missing</Status>
              ),
          },
          {
            key: 'bytes',
            label: 'Size',
            align: 'end',
            value: (source) => source.bytes,
            render: (source) => (
              <SecondaryCell>
                {source.bytes === null
                  ? EMPTY_VALUE
                  : `${(source.bytes / 1024 / 1024).toFixed(1)} MB`}
              </SecondaryCell>
            ),
          },
        ]}
      />
    </section>
  )
}
