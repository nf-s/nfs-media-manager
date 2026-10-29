'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ImportRunSchema } from '@repo/schemas/imports'
import { Button } from '@repo/ui/components/ui/button'
import { TableScroll, TableState } from '@repo/ui/components/ui/table'
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
    <section className="admin-page">
      <h1>Legacy JSON library</h1>
      <ImportStatusNotice />
      <p className="muted">
        Mixed album and film library import, shared between both scopes. Imports
        local library data only. No metadata scraping.
      </p>
      <TableScroll
        className="my-4"
        role="region"
        aria-label="Legacy import sources"
        aria-busy={query.isFetching}
      >
        <table className="compact-table" aria-label="Legacy import sources">
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Updated</th>
              <th scope="col">Size</th>
            </tr>
          </thead>
          <tbody>
            {!query.data?.sources.length && (
              <TableState colSpan={3} error={query.isError}>
                {query.isPending
                  ? 'Loading sources...'
                  : query.isError
                    ? 'Sources unavailable.'
                    : 'No import sources.'}
              </TableState>
            )}
            {query.data?.sources.map((source) => (
              <tr key={source.name}>
                <td>{source.name}</td>
                <td>
                  {source.available
                    ? source.updatedAt?.slice(0, 10)
                    : 'Missing'}
                </td>
                <td>
                  {source.bytes
                    ? `${(source.bytes / 1024 / 1024).toFixed(1)} MB`
                    : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      <div className="import-actions">
        <Button
          disabled={
            running ||
            start.isPending ||
            query.isPending ||
            query.isError ||
            !query.data?.sources.length ||
            !query.data.sources.every((source) => source.available)
          }
          onClick={() => start.mutate()}
        >
          {start.isPending
            ? 'Starting...'
            : fullLibrary
              ? 'Import full library'
              : 'Test import: 2 albums + 2 films'}
        </Button>
        <label className="check-label">
          <input
            type="checkbox"
            checked={fullLibrary}
            disabled={running || start.isPending}
            onChange={(event) => setFullLibrary(event.target.checked)}
          />
          Import all local records
        </label>
      </div>
      {start.isError && <p role="alert">{start.error.message}</p>}
    </section>
  )
}
