'use client'

import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Job } from '@repo/schemas/job'
import {
  ProviderResponsePageSchema,
  ProviderResponseSchema,
  type ProviderResponseBody,
  type ProviderResponseSummary,
} from '@repo/schemas/provider-response'
import { KeyValues, Section } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Button } from '@repo/ui/components/ui/button'
import {
  TableCell,
  TableHead,
  TableRow,
  TableState,
} from '@repo/ui/components/ui/table'
import { formatCount, formatDateTime } from '@repo/ui/lib/format'
import { Label } from '@repo/ui/components/ui/label'
import { Input } from '@repo/ui/components/ui/input'
import { openLocalResponseArchive } from '@/utils/local-response-archive'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { fetchApiData } from '@/utils/api'
import { canCancelJob } from '@/utils/job-selection'
import { useDetailView } from './detail-inspector-context'
import { useConfig } from './providers'
import { SecondaryTableScroll, SecondaryVirtualRows } from './secondary-table'

type DataJob = Pick<Job, 'id' | 'status'>

const unavailableReasons = {
  empty: 'The provider returned an empty body.',
  'byte-limit': 'The response exceeded the capture limit.',
  'capture-limit': 'The request exceeded the capture limit for this job.',
  'read-failed': 'The response body could not be read.',
  'unsupported-format': 'This response format could not be archived safely.',
  'local-response': 'The worker returned no archive of the original response.',
  policy: 'This response was excluded by the capture policy.',
  'redact-failed': 'Private fields could not be removed safely.',
  'transport-error': 'The request failed before a response could be saved.',
} satisfies Record<
  Extract<ProviderResponseBody, { state: 'unavailable' }>['reason'],
  string
>

function requestLabel(row: ProviderResponseSummary) {
  return `Attempt ${formatCount(row.attempt)} · Request ${formatCount(row.ordinal)} · ${row.phase === 'artist' ? 'Artist' : row.phase === 'task' ? 'Task' : 'Media'}`
}

export function JobProviderResponseBody({
  body,
}: {
  body: ProviderResponseBody
}) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  if (body.state === 'unavailable')
    return <p className="ds-help">{unavailableReasons[body.reason]}</p>
  if (body.state === 'local') return <LocalResponseArchive receipt={body} />

  return (
    <>
      <div className="ds-actions dtl-wrap">
        <Button
          size="xs"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(body.text)
              setCopy('copied')
            } catch {
              setCopy('failed')
            }
          }}
        >
          {copy === 'copied' ? 'Copied' : 'Copy response'}
        </Button>
        {copy === 'failed' && (
          <span role="status" className="ds-help">
            Copy failed. Select and copy the response below.
          </span>
        )}
        {body.retainedRepresentation === 'station-discovery' ? (
          <span className="ds-help">
            Saved public discovery references from the page or script.
          </span>
        ) : body.retainedRepresentation === 'station-episode-data' ? (
          <span className="ds-help">
            Saved episode data rows from the archive response.
          </span>
        ) : body.redacted ? (
          <span className="ds-help">Private fields removed.</span>
        ) : null}
      </div>
      <pre className="ops-pre">{body.text}</pre>
    </>
  )
}

function LocalResponseArchive({
  receipt,
}: {
  receipt: Extract<ProviderResponseBody, { state: 'local' }>
}) {
  const inputId = useId()
  const [reading, setReading] = useState(false)
  const [error, setError] = useState(false)
  const [opened, setOpened] =
    useState<Extract<ProviderResponseBody, { state: 'captured' }>>()
  async function open(file?: File) {
    if (!file) return
    setReading(true)
    setError(false)
    setOpened(undefined)
    try {
      setOpened(await openLocalResponseArchive(file, receipt))
    } catch {
      setError(true)
    } finally {
      setReading(false)
    }
  }
  return (
    <div className="data-stack">
      <KeyValues
        items={[
          { label: 'Stored on', value: 'Paired local worker' },
          {
            label: 'Archive reference',
            value: <code className="break-all">{receipt.reference}</code>,
          },
          { label: 'Saved bytes', value: formatCount(receipt.retainedBytes) },
        ]}
      />
      <Label htmlFor={inputId}>Open worker archive on this device</Label>
      <Input
        id={inputId}
        type="file"
        accept=".json,application/json"
        disabled={reading}
        onChange={(event) => {
          void open(event.target.files?.[0])
          event.target.value = ''
        }}
      />
      {reading && (
        <p role="status" className="ds-help">
          Reading archive…
        </p>
      )}
      {error && (
        <Notice tone="danger">
          The selected file could not be verified against this response.
        </Notice>
      )}
      {opened && <JobProviderResponseBody body={opened} />}
    </div>
  )
}

function StoredResponse({
  base,
  jobId,
  responseId,
}: {
  base: string
  jobId: string
  responseId: string
}) {
  const { apiBaseUrl } = useConfig()
  const result = useQuery({
    queryKey: ['jobs', 'provider-response', jobId, responseId],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `${base}/${encodeURIComponent(responseId)}`,
        ProviderResponseSchema,
        { signal },
      ),
    retry: false,
    staleTime: Infinity,
  })
  const row = result.data
  return (
    <Section title={row ? requestLabel(row) : 'Saved response'}>
      {row && (
        <KeyValues
          items={[
            { label: 'Provider', value: row.provider },
            {
              label: 'Request',
              value: (
                <span className="break-all">
                  {[row.method, row.requestUrl].filter(Boolean).join(' ')}
                </span>
              ),
            },
            {
              label: 'Status',
              value:
                row.status === null ? 'No HTTP status' : `HTTP ${row.status}`,
            },
            ...(row.receivedAt
              ? [{ label: 'Received', value: formatDateTime(row.receivedAt) }]
              : []),
            ...(row.contentType
              ? [{ label: 'Content type', value: row.contentType }]
              : []),
          ]}
        />
      )}
      {result.isPending && (
        <p role="status" className="ds-help">
          Loading saved response…
        </p>
      )}
      {result.isError && (
        <Notice
          tone="danger"
          action={
            <Button size="xs" onClick={() => result.refetch()}>
              Retry
            </Button>
          }
        >
          Could not read the saved response.
        </Notice>
      )}
      {row && <JobProviderResponseBody body={row.body} />}
    </Section>
  )
}

export function JobProviderResponses({ job }: { job: DataJob }) {
  const { apiBaseUrl } = useConfig()
  const view = useDetailView()
  const selected = view.params.get('jobResponse')
  const base = `/api/v1/scrape/jobs/${encodeURIComponent(job.id)}/data/responses`
  const rows = useVirtualTable({
    queryKey: ['jobs', 'provider-responses', job.id, job.status],
    pageSize: 24,
    refetchInterval: canCancelJob(job) ? 3000 : undefined,
    loadPage: (page, size, signal) =>
      fetchApiData(
        apiBaseUrl,
        `${base}?${new URLSearchParams({ page: String(page), size: String(size) })}`,
        ProviderResponsePageSchema,
        { signal },
      ),
  })
  return (
    <Section
      flush
      title="Provider responses"
      note={rows.hasTotal ? formatCount(rows.total) : undefined}
    >
      {rows.isError && (
        <Notice
          tone="danger"
          action={
            <Button size="xs" onClick={rows.retry}>
              Retry
            </Button>
          }
        >
          Could not load provider response history.
        </Notice>
      )}
      {rows.hasTotal && !rows.total ? (
        <p className="ds-help" role="status">
          {canCancelJob(job)
            ? 'No provider response captured yet.'
            : 'No original provider response was archived for this job.'}
        </p>
      ) : (
        <SecondaryTableScroll
          ref={rows.scroller}
          onScroll={rows.onScroll}
          className="table-scroll-bounded"
          role="region"
          aria-label="Provider responses"
          aria-busy={rows.isFetching}
        >
          <table
            className="ds-table"
            aria-label="Recorded requests"
            aria-rowcount={rows.hasTotal ? rows.total + 1 : undefined}
          >
            <thead>
              <TableRow>
                <TableHead>Request</TableHead>
                <TableHead>Result</TableHead>
              </TableRow>
            </thead>
            <tbody>
              {rows.isError && !rows.hasTotal && (
                <TableState colSpan={2}>Response list unavailable.</TableState>
              )}
              <SecondaryVirtualRows
                window={rows}
                colSpan={2}
                renderRow={(row, index) => (
                  <TableRow aria-rowindex={index + 2}>
                    <TableCell>
                      <Button
                        variant="link"
                        size="xs"
                        aria-pressed={selected === row.id}
                        onClick={() => {
                          const params = new URLSearchParams(view.params)
                          params.set('jobResponse', row.id)
                          view.replace(params)
                        }}
                      >
                        {requestLabel(row)}
                      </Button>
                    </TableCell>
                    <TableCell>
                      {row.status === null
                        ? 'No response'
                        : `HTTP ${row.status}`}
                    </TableCell>
                  </TableRow>
                )}
              />
            </tbody>
          </table>
        </SecondaryTableScroll>
      )}
      {selected && (
        <StoredResponse
          key={selected}
          base={base}
          jobId={job.id}
          responseId={selected}
        />
      )}
    </Section>
  )
}
