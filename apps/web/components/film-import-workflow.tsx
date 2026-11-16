'use client'

import Link from 'next/link'
import { useId, useState } from 'react'
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
import { Label } from '@repo/ui/components/ui/label'
import { KeyValues } from '@repo/ui/components/ds/facts'
import { Notice, State } from '@repo/ui/components/ds/feedback'
import { Status } from '@repo/ui/components/ds/status'
import { Select } from '@repo/ui/components/ds/toolbar'
import {
  formatCount,
  formatDateTime,
  formatItemCount,
} from '@repo/ui/lib/format'
import ImportPreviewTable from './import-preview-table'
import { SecondaryCell } from './secondary-table'
import { ConfirmAction } from './confirm-action'
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
  if (typeof value === 'number' && /date/i.test(field))
    return formatDateTime(value)
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return typeof value === 'string' ? value : JSON.stringify(value)
}

const FILMS = { one: 'film', other: 'films' }

function changeSummary(item: FilmImportPreview['items'][number]) {
  return item.action === 'new'
    ? 'New film'
    : item.action === 'unchanged'
      ? 'No changes'
      : [...new Set(item.changes.map((change) => change.label))].join(', ')
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
  const selection = useFilmProviders()
  const formatId = useId()
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
    },
  })
  const start = useMutation({
    mutationFn: (confirmBroadRun: boolean) =>
      fetchApiData(apiBaseUrl, '/api/v1/imports/film-import', ImportRunSchema, {
        method: 'POST',
        body: JSON.stringify({
          previewId: preview.data?.id,
          rows,
          providers: selection.selected,
          confirmBroadRun,
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
  const summary = preview.data
    ? [
        formatItemCount(preview.data.items.length, FILMS),
        `${formatCount(newCount)} new`,
        ...(kind === 'csv'
          ? [
              `${formatCount(updatedCount)} with changes`,
              `${formatCount(unchangedCount)} unchanged`,
            ]
          : [
              `${formatCount(preview.data.existing)} already in library (skipped)`,
            ]),
        `${formatCount(preview.data.skipped)} skipped`,
      ].join(' · ')
    : ''
  return (
    <div className="sec-fill">
      <div className="ds-panelpad sec-form">
        {showSourcePicker && (
          <div className="ds-actions" role="group" aria-label="Import source">
            <Button
              size="md"
              aria-pressed={kind === 'csv'}
              disabled={busy}
              onClick={() => {
                setKind('csv')
                reset()
              }}
            >
              Import CSV
            </Button>
            <Button
              size="md"
              aria-pressed={kind === 'nfo'}
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
          <>
            {showSourcePicker && (
              <div className="ds-field">
                <Label htmlFor={formatId}>CSV type</Label>
                <Select
                  id={formatId}
                  controlSize="md"
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
                </Select>
              </div>
            )}
            <label
              className="sec-drop"
              data-dragging={dragging || undefined}
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
              <span>
                {reading || preview.isPending
                  ? 'Checking CSV...'
                  : 'Drop a CSV here or choose a file'}
              </span>
              <input
                key={format}
                type="file"
                accept=".csv,text/csv"
                aria-label="Choose CSV file"
                disabled={busy}
                onChange={(event) => void chooseFile(event.target.files?.[0])}
              />
              <span className="ds-help">
                Preview only. Nothing is imported until you confirm.
              </span>
            </label>
          </>
        ) : (
          <>
            <KeyValues
              items={[
                {
                  label: 'Server folder',
                  value: (
                    <code className="ds-mono">
                      {source.data?.path ?? 'Not configured'}
                    </code>
                  ),
                },
              ]}
            />
            {source.data && !source.data.available && (
              <Notice tone="danger">
                The server folder is unavailable. Check the mounted volume and
                SCAN_DIR.
              </Notice>
            )}
            <span className="ds-actions">
              <Button
                size="md"
                variant={preview.data ? 'default' : 'primary'}
                disabled={busy || !source.data?.available}
                onClick={() => {
                  reset()
                  preview.mutate({ kind: 'nfo' })
                }}
              >
                {preview.isPending
                  ? 'Scanning folders...'
                  : 'Preview new films'}
              </Button>
            </span>
          </>
        )}
        {(error || preview.isError || start.isError) && (
          <Notice tone="danger">
            {error || preview.error?.message || start.error?.message}
          </Notice>
        )}
      </div>
      {preview.data && (
        <div className="sec-fill sec-review">
          <p className="ds-help sec-pad" role="status">
            {summary}
          </p>
          {!!preview.data.items.length && (
            <ImportPreviewTable
              key={preview.data.id}
              items={preview.data.items}
              selected={rows}
              onChange={setRows}
              disabled={busy || start.isSuccess}
              actionable={(item) => item.action !== 'unchanged'}
              storageKey={`film-${kind}-import-preview`}
              searchValue={(item) =>
                [item.title, ...item.identifiers].join(' ')
              }
              filterColumn="changes"
              footer={
                <>
                  <FilmProviderSelection
                    providers={selection.providers}
                    selected={selection.selected}
                    onChange={selection.setSelected}
                    disabled={busy || start.isSuccess}
                  />
                  <span className="ds-muted">
                    {selection.selected.length
                      ? `Up to ${formatCount(jobs)} metadata jobs for ${formatCount(selectedNewCount)} new films only. Existing films never queue metadata from CSV imports; provider pacing and cooldowns apply.`
                      : 'Import only. No provider requests.'}{' '}
                    Films without IDs stay in the library for identification.
                  </span>
                  <span className="ds-actions ds-toolbar-end">
                    <ConfirmAction
                      variant="primary"
                      confirm={jobs > 5}
                      question={`Import ${formatItemCount(rows.length, FILMS)}?`}
                      details={`Queues metadata for these new films: up to ${formatCount(jobs)} jobs.`}
                      confirmLabel="Import"
                      disabled={
                        busy ||
                        start.isSuccess ||
                        !rows.length ||
                        selection.isPending ||
                        selection.isError
                      }
                      onConfirm={() => start.mutate(jobs > 5)}
                    >
                      {start.isPending
                        ? 'Starting...'
                        : `Import ${rows.length} films`}
                    </ConfirmAction>
                  </span>
                </>
              }
              filters={
                kind === 'csv'
                  ? [
                      {
                        key: 'pending',
                        label: 'New or changed',
                        matches: (item) => item.action !== 'unchanged',
                      },
                      {
                        key: 'new',
                        label: 'New',
                        matches: (item) => item.action === 'new',
                      },
                      {
                        key: 'changed',
                        label: 'Changed',
                        matches: (item) => item.action === 'update',
                      },
                      {
                        key: 'unchanged',
                        label: 'Unchanged',
                        matches: (item) => item.action === 'unchanged',
                      },
                    ]
                  : []
              }
              columns={[
                { key: 'title', label: 'Film', value: (item) => item.title },
                {
                  key: 'identifiers',
                  label: 'Identifiers',
                  value: (item) =>
                    item.needsIdentification
                      ? 'Needs ID'
                      : item.identifiers.join(', '),
                  render: (item) =>
                    item.needsIdentification ? (
                      <Status state="attention">Needs ID</Status>
                    ) : (
                      <SecondaryCell>
                        {item.identifiers.join(', ')}
                      </SecondaryCell>
                    ),
                },
                {
                  key: 'changes',
                  label: 'Changes',
                  value: (item) => changeSummary(item),
                  render: (item) => (
                    <SecondaryCell
                      text={
                        item.action === 'update'
                          ? changeSummary(item)
                          : undefined
                      }
                      label={`Changes to ${item.title}`}
                      details={
                        item.action === 'update' ? (
                          <dl className="ds-kv">
                            {item.changes.map((change, index) => (
                              <div
                                key={`${change.field}:${index}`}
                                className="contents"
                              >
                                <dt>{change.label}</dt>
                                <dd className="break-all">
                                  {changeValue(change.before, change.field)} →{' '}
                                  {changeValue(change.after, change.field)}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        ) : undefined
                      }
                    >
                      {changeSummary(item)}
                    </SecondaryCell>
                  ),
                },
              ]}
            />
          )}
          {preview.data.items.length === 0 && (
            <State size="sm" title="No new films to import" />
          )}
          {preview.data.warnings.length > 0 && (
            <details className="sec-pad">
              <summary>{preview.data.warnings.length} import warnings</summary>
              {preview.data.warnings.map((warning, index) => (
                <p key={index}>{warning}</p>
              ))}
            </details>
          )}
          {start.data && (
            <div className="sec-notices">
              <Notice>
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
              </Notice>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
