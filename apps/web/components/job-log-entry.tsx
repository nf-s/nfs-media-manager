'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { JsonValueSchema } from '@repo/schemas/common'
import {
  JobSchema,
  JobErrorDetailsSchema,
  type Job,
  type JobErrorDetails,
} from '@repo/schemas/job'
import { Button } from '@repo/ui/components/ui/button'
import { fetchApiData } from '@/utils/api'
import { useConfig } from './providers'
import JsonTree from './json-tree'

const ErrorMetadataSchema = z.object({ error: JobErrorDetailsSchema })
const DiagnosticMetadataSchema = z.object({ diagnostics: JsonValueSchema })
const LegacyJobContextSchema = z.object({
  jobHistorySplit: z.object({ context: z.literal('legacy-batch') }),
})

function JobRequestError({
  error,
}: {
  error: JobErrorDetails['causes'][number]
}) {
  const { diagnostics, code, retryAt } = error
  const quotaLabels: Record<string, string> = {
    'x-ratelimit-limit': 'Limit',
    'x-ratelimit-remaining': 'Remaining',
    'x-ratelimit-reset': 'Reset',
    'x-discogs-ratelimit': 'Discogs limit',
    'x-discogs-ratelimit-used': 'Discogs used',
    'x-discogs-ratelimit-remaining': 'Discogs remaining',
  }
  return (
    <div className="grid gap-1" aria-label="Request error details">
      <p>
        <strong>
          {diagnostics?.source === 'provider-response'
            ? `Provider response${diagnostics.httpStatus !== undefined ? ` · HTTP ${diagnostics.httpStatus}` : ''}`
            : diagnostics?.source === 'local-cooldown'
              ? 'Local cooldown · No outgoing request'
              : diagnostics?.source === 'local-budget'
                ? 'Local request budget · No outgoing request'
                : diagnostics?.source === 'local-access-halt'
                  ? 'Local access block · No outgoing request'
                  : 'Provider request error'}
        </strong>
      </p>
      {code && <p>Code: {code}</p>}
      {diagnostics?.quotaError && <p>Provider reported a quota error.</p>}
      {diagnostics?.responseReceivedAt && (
        <p>
          Received{' '}
          <time dateTime={diagnostics.responseReceivedAt}>
            {new Date(diagnostics.responseReceivedAt).toLocaleString()}
          </time>
        </p>
      )}
      {diagnostics?.retryAfter && (
        <p>
          Retry-After:{' '}
          {'seconds' in diagnostics.retryAfter ? (
            `${diagnostics.retryAfter.seconds} seconds`
          ) : (
            <time dateTime={diagnostics.retryAfter.at}>
              {new Date(diagnostics.retryAfter.at).toLocaleString()}
            </time>
          )}
        </p>
      )}
      {retryAt !== undefined && retryAt !== null && (
        <>
          <p>
            {diagnostics?.source === 'provider-response'
              ? 'Request retry time'
              : diagnostics
                ? 'Local retry time'
                : 'Recorded retry time'}{' '}
            <time dateTime={new Date(retryAt).toISOString()}>
              {new Date(retryAt).toLocaleString()}
            </time>
          </p>
          {diagnostics?.source === 'provider-response' && (
            <p className="muted">
              Provider cooldowns and dispatch pauses can delay execution.
            </p>
          )}
        </>
      )}
      {diagnostics?.quotaHeaders && (
        <dl className="flex flex-wrap gap-x-4 gap-y-1">
          {Object.entries(diagnostics.quotaHeaders).map(([name, value]) => (
            <div key={name} className="flex gap-1" title={name}>
              <dt>{quotaLabels[name] ?? name}:</dt>
              <dd>{value?.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

export function JobLogEntry({
  log,
  jobId,
}: {
  log: Job['logs'][number]
  jobId: string
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const review = useMutation({
    mutationFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/scrape/jobs/${encodeURIComponent(jobId)}/logs/${encodeURIComponent(log.id)}/benign`,
        JobSchema,
        {
          method: 'POST',
          body: JSON.stringify({ confirm: true }),
        },
      ),
    onSuccess: async () => {
      setConfirming(false)
      await client.invalidateQueries({ queryKey: ['jobs'] })
      await client.invalidateQueries({ queryKey: ['job-activity'] })
    },
  })
  const parsed = ErrorMetadataSchema.safeParse(log.metadata)
  const error = parsed.success ? parsed.data.error : null
  const requestErrors = new Map<string, JobErrorDetails['causes'][number]>()
  for (const entry of error ? [error, ...error.causes] : []) {
    if (entry.diagnostics || entry.code || entry.retryAt !== undefined) {
      const identity = JSON.stringify({
        code: entry.code,
        retryAt: entry.retryAt,
        diagnostics: entry.diagnostics,
      })
      if (!requestErrors.has(identity)) requestErrors.set(identity, entry)
    }
  }
  const diagnosticMetadata = DiagnosticMetadataSchema.safeParse(log.metadata)
  return (
    <li className="job-log" data-level={log.level}>
      <time dateTime={log.createdAt}>
        {new Date(log.createdAt).toLocaleTimeString()}
      </time>
      <span className="job-log-level">{log.level}</span>
      <div>
        <p>{log.message}</p>
        {LegacyJobContextSchema.safeParse(log.metadata).success && (
          <p className="muted">
            Original batch context, not an item-specific event.
          </p>
        )}
        {log.benignReview ? (
          <p className="muted">
            Marked benign ·{' '}
            {new Date(log.benignReview.reviewedAt).toLocaleString()}
          </p>
        ) : log.canMarkBenign ? (
          <div>
            {confirming && (
              <p className="muted">
                Only this error will be dismissed. No retry, limit reset or rule
                for future errors.
              </p>
            )}
            <Button
              variant="outline"
              disabled={review.isPending}
              onClick={() =>
                confirming ? review.mutate() : setConfirming(true)
              }
            >
              {review.isPending
                ? 'Saving...'
                : confirming
                  ? 'Confirm benign'
                  : 'Mark benign'}
            </Button>
            {confirming && (
              <Button
                variant="ghost"
                disabled={review.isPending}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            )}
            {review.isError && <p role="alert">{review.error.message}</p>}
          </div>
        ) : null}
        {[...requestErrors].map(([identity, entry]) => (
          <JobRequestError key={identity} error={entry} />
        ))}
        {error ? (
          <pre className="job-error">
            {[
              error.stack ?? `${error.name}: ${error.message}`,
              ...error.causes.map(
                (cause) =>
                  `Caused by: ${cause.stack ?? `${cause.name}: ${cause.message}`}`,
              ),
            ].join('\n\n')}
          </pre>
        ) : log.level === 'error' ? (
          <p className="muted">
            No error details were recorded for this entry.
          </p>
        ) : null}
        {diagnosticMetadata.success &&
          diagnosticMetadata.data.diagnostics !== null && (
            <details
              onToggle={(event) => setDiagnosticsOpen(event.currentTarget.open)}
            >
              <summary>Diagnostics</summary>
              {diagnosticsOpen && (
                <JsonTree value={diagnosticMetadata.data.diagnostics} />
              )}
            </details>
          )}
      </div>
    </li>
  )
}
