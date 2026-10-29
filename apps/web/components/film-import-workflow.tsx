'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import {
  FileImportFormatSchema,
  FilmImportPreviewSchema,
  FilmPreviewInputSchema,
  ImportRunSchema,
  NfoSourceSchema,
  type FilmImportPreview,
} from '@repo/schemas/imports'
import { Button } from '@repo/ui/components/ui/button'
import ImportPreviewTable from './import-preview-table'
import { scopedHref } from '@/utils/media-scope'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { FilterIndicator } from './filter-affordance'
import {
  FilmProviderSelection,
  useFilmProviders,
} from './film-provider-selection'

function changeValue(
  value: FilmImportPreview['items'][number]['changes'][number]['before'],
  field: string,
) {
  if (value === null) return 'Not set'
  if (typeof value === 'number' && /date/i.test(field)) {
    const date = new Date(value)
    if (Number.isFinite(date.getTime())) return date.toLocaleString()
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export default function FilmImportWorkflow({
  running,
  initialKind = 'csv',
  initialFormat = 'imdb-ratings',
  showSourcePicker = true,
}: {
  running: boolean
  initialKind?: 'csv' | 'nfo'
  initialFormat?: string
  showSourcePicker?: boolean
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [kind, setKind] = useState<'csv' | 'nfo'>(initialKind)
  const [format, setFormat] = useState(initialFormat)
  const [rows, setRows] = useState<number[]>([])
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const selection = useFilmProviders()
  const formats = useQuery({
    queryKey: ['import-formats'],
    enabled: showSourcePicker,
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/imports/formats',
        z.array(FileImportFormatSchema),
      ),
  })
  const source = useQuery({
    queryKey: ['nfo-source'],
    enabled: kind === 'nfo',
    queryFn: () =>
      fetchApiData(apiBaseUrl, '/api/v1/imports/nfo-source', NfoSourceSchema),
  })
  const preview = useMutation({
    mutationFn: (input: z.infer<typeof FilmPreviewInputSchema>) =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/imports/film-preview',
        FilmImportPreviewSchema,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: (data) => {
      setRows(
        data.items
          .filter((item) => item.action !== 'unchanged')
          .map((item) => item.row),
      )
      setConfirmed(false)
    },
  })
  const start = useMutation({
    mutationFn: () =>
      fetchApiData(apiBaseUrl, '/api/v1/imports/film-import', ImportRunSchema, {
        method: 'POST',
        body: JSON.stringify({
          previewId: preview.data?.id,
          rows,
          providers: selection.selected,
          confirmBroadRun: confirmed,
        }),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['imports'] })
      await client.invalidateQueries({ queryKey: ['job-activity'] })
    },
  })
  const busy = reading || preview.isPending || start.isPending || running
  function reset() {
    preview.reset()
    start.reset()
    setError('')
    setRows([])
    setConfirmed(false)
  }
  async function chooseFile(file: File | undefined) {
    if (!file || busy) return
    reset()
    if (!/\.csv$/i.test(file.name) || file.size > 20 * 1024 * 1024) {
      setError('Choose a CSV file smaller than 20 MB.')
      return
    }
    setReading(true)
    try {
      await preview.mutateAsync({
        kind: 'csv',
        format,
        fileName: file.name,
        content: await file.text(),
      })
    } catch (error) {
      const details = z.object({ message: z.string() }).safeParse(error)
      setError(
        details.success
          ? details.data.message
          : 'Could not read this CSV file.',
      )
    } finally {
      setReading(false)
    }
  }
  const selectedRows = new Set(rows)
  const newCount =
    preview.data?.items.filter((item) => item.action === 'new').length ?? 0
  const updatedCount =
    preview.data?.items.filter((item) => item.action === 'update').length ?? 0
  const unchangedCount =
    preview.data?.items.filter((item) => item.action === 'unchanged').length ??
    0
  const selectedNewCount =
    preview.data?.items.filter(
      (item) => item.action === 'new' && selectedRows.has(item.row),
    ).length ?? 0
  const jobs = selectedNewCount * selection.selected.length
  return (
    <section className="film-import-workflow">
      {showSourcePicker && (
        <div className="import-kind" role="group" aria-label="Import source">
          <Button
            variant={kind === 'csv' ? 'default' : 'outline'}
            disabled={busy}
            onClick={() => {
              setKind('csv')
              reset()
            }}
          >
            Import CSV
          </Button>
          <Button
            variant={kind === 'nfo' ? 'default' : 'outline'}
            disabled={busy}
            onClick={() => {
              setKind('nfo')
              reset()
            }}
          >
            Find new NFO films
          </Button>
        </div>
      )}
      {kind === 'csv' ? (
        <div className="csv-upload">
          {showSourcePicker && (
            <label>
              CSV type
              <select
                aria-label="CSV type"
                value={format}
                disabled={busy}
                onChange={(event) => {
                  setFormat(event.target.value)
                  reset()
                }}
              >
                {formats.data
                  ?.filter((item) => item.kind === 'csv')
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label
            className={`csv-dropzone${dragging ? ' dragging' : ''}`}
            onDragOver={(event) => {
              event.preventDefault()
              if (!busy) setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault()
              setDragging(false)
              void chooseFile(event.dataTransfer.files[0])
            }}
          >
            <input
              key={format}
              type="file"
              accept=".csv,text/csv"
              aria-label="Choose CSV file"
              disabled={busy}
              onChange={(event) => void chooseFile(event.target.files?.[0])}
            />
            <span>
              {reading || preview.isPending
                ? 'Checking CSV...'
                : 'Drop a CSV here or choose a file'}
            </span>
            <small>Preview only. Nothing is imported until you confirm.</small>
          </label>
        </div>
      ) : (
        <div className="nfo-source">
          <div>
            <span className="muted">Server folder</span>
            <code>{source.data?.path ?? 'Not configured'}</code>
          </div>
          <Button
            disabled={busy || !source.data?.available}
            onClick={() => {
              reset()
              preview.mutate({ kind: 'nfo' })
            }}
          >
            {preview.isPending ? 'Scanning folders...' : 'Preview new films'}
          </Button>
          {source.data && !source.data.available && (
            <p role="alert">
              The server folder is unavailable. Check the mounted volume and
              SCAN_DIR.
            </p>
          )}
        </div>
      )}
      {(error || preview.isError || start.isError) && (
        <p role="alert">
          {error || preview.error?.message || start.error?.message}
        </p>
      )}
      {preview.data && (
        <div className="import-review">
          <div className="import-review-summary">
            <strong>{preview.data.items.length} films</strong>
            <span>{newCount} new</span>
            {kind === 'csv' ? (
              <>
                <span>{updatedCount} with changes</span>
                <span>{unchangedCount} unchanged</span>
              </>
            ) : (
              <span>{preview.data.existing} already in library (skipped)</span>
            )}
            <span>{preview.data.skipped} skipped</span>
          </div>
          {!!preview.data.items.length && (
            <>
              <ImportPreviewTable
                key={preview.data.id}
                items={preview.data.items}
                selected={rows}
                onChange={(value) => {
                  setRows(value)
                  setConfirmed(false)
                }}
                disabled={busy || start.isSuccess}
                actionable={(item) => item.action !== 'unchanged'}
                headings={
                  <>
                    <th scope="col">Film</th>
                    <th scope="col">Identifiers</th>
                    <th scope="col">Changes</th>
                  </>
                }
                cells={(item) => (
                  <>
                    {' '}
                    <td>{item.title}</td>
                    <td>
                      {item.needsIdentification ? (
                        <span className="needs-id">Needs ID</span>
                      ) : (
                        item.identifiers.join(', ')
                      )}
                    </td>
                    <td>
                      {item.action === 'new' ? (
                        'New film'
                      ) : item.action === 'unchanged' ? (
                        'No changes'
                      ) : (
                        <details>
                          <summary>
                            {[
                              ...new Set(
                                item.changes.map((change) => change.label),
                              ),
                            ].join(', ')}
                          </summary>
                          <dl className="text-xs">
                            {item.changes.map((change, index) => (
                              <div key={`${change.field}:${index}`}>
                                <dt>{change.label}</dt>
                                <dd className="break-all">
                                  {changeValue(change.before, change.field)} →{' '}
                                  {changeValue(change.after, change.field)}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </details>
                      )}
                    </td>
                  </>
                )}
              />
              <div className="import-confirmation">
                <FilmProviderSelection
                  providers={selection.providers}
                  selected={selection.selected}
                  onChange={(value) => {
                    selection.setSelected(value)
                    setConfirmed(false)
                  }}
                  disabled={busy || start.isSuccess}
                />
                <p className="muted">
                  {selection.selected.length
                    ? `Up to ${jobs} metadata jobs for ${selectedNewCount} new films only. Existing films never queue metadata from CSV imports; provider pacing and cooldowns apply.`
                    : 'Import only. No provider requests.'}{' '}
                  Films without IDs stay in the library for identification.
                </p>
                {jobs > 5 && (
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                      disabled={busy || start.isSuccess}
                    />
                    Queue metadata for these new films
                  </label>
                )}
                <Button
                  disabled={
                    busy ||
                    start.isSuccess ||
                    !rows.length ||
                    selection.isPending ||
                    selection.isError ||
                    (jobs > 5 && !confirmed)
                  }
                  onClick={() => start.mutate()}
                >
                  {start.isPending
                    ? 'Starting...'
                    : `Import ${rows.length} films`}
                </Button>
              </div>
            </>
          )}
          {preview.data.items.length === 0 && (
            <p className="muted">No new films to import.</p>
          )}
          {preview.data.warnings.length > 0 && (
            <details>
              <summary>{preview.data.warnings.length} import warnings</summary>
              {preview.data.warnings.map((warning, index) => (
                <p key={index}>{warning}</p>
              ))}
            </details>
          )}
          {start.data && (
            <p role="status">
              Import started.{' '}
              <Link href={scopedHref('/imports', 'film')}>
                View import progress
              </Link>
              .{' '}
              <Link
                href={scopedHref(`/jobs?batchId=${preview.data.id}`, 'film')}
              >
                View metadata jobs
              </Link>{' '}
              ·{' '}
              <Link
                href={`/films?filters=${encodeURIComponent(JSON.stringify([{ field: 'identification', value: 'Needs ID' }]))}`}
              >
                <FilterIndicator />
                Identify films missing IDs
              </Link>
            </p>
          )}
        </div>
      )}
    </section>
  )
}
