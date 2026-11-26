'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { JsonValueSchema } from '@repo/schemas/common'
import {
  JobActivityLogMetadataSchema,
  JobSchema,
  JobErrorDetailsSchema,
  type Job,
  type JobErrorDetails,
} from '@repo/schemas/job'
import { KeyValues } from '@repo/ui/components/ds/facts'
import { Status } from '@repo/ui/components/ds/status'
import { Button, mutationFeedback } from '@repo/ui/components/ui/button'
import { formatCount, formatDateTime, formatElapsed } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { jobActivityCount, jobActivityLabel } from '@/utils/job-activity'
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
  const source =
    diagnostics?.source === 'provider-response'
      ? `Provider response${diagnostics.httpStatus !== undefined ? ` · HTTP ${diagnostics.httpStatus}` : ''}`
      : diagnostics?.source === 'local-cooldown'
        ? 'Local cooldown · No outgoing request'
        : diagnostics?.source === 'local-budget'
          ? 'Local request budget · No outgoing request'
          : diagnostics?.source === 'local-access-halt'
            ? 'Local access block · No outgoing request'
            : 'Provider request error'
  const items = [
    ...(code ? [{ label: 'Code', value: code }] : []),
    ...(diagnostics?.quotaError
      ? [{ label: 'Quota', value: 'Provider reported a quota error.' }]
      : []),
    ...(diagnostics?.responseReceivedAt
      ? [
          {
            label: 'Received',
            value: (
              <time dateTime={diagnostics.responseReceivedAt}>
                {formatDateTime(diagnostics.responseReceivedAt)}
              </time>
            ),
          },
        ]
      : []),
    ...(diagnostics?.retryAfter
      ? [
          {
            label: 'Retry-After',
            value:
              'seconds' in diagnostics.retryAfter ? (
                `${formatCount(diagnostics.retryAfter.seconds)} seconds`
              ) : (
                <time dateTime={diagnostics.retryAfter.at}>
                  {formatDateTime(diagnostics.retryAfter.at)}
                </time>
              ),
          },
        ]
      : []),
    ...(retryAt !== undefined && retryAt !== null
      ? [
          {
            label:
              diagnostics?.source === 'provider-response'
                ? 'Request retry time'
                : diagnostics
                  ? 'Local retry time'
                  : 'Recorded retry time',
            value: (
              <time dateTime={new Date(retryAt).toISOString()}>
                {formatDateTime(retryAt)}
              </time>
            ),
          },
        ]
      : []),
    ...Object.entries(diagnostics?.quotaHeaders ?? {}).map(([name, value]) => ({
      label: quotaLabels[name] ?? name,
      value: value === undefined ? '' : formatCount(value),
    })),
  ]
  return (
    <div className="ops-log-block" aria-label="Request error details">
      <strong>{source}</strong>
      {items.length > 0 && <KeyValues items={items} />}
      {retryAt !== undefined &&
        retryAt !== null &&
        diagnostics?.source === 'provider-response' && (
          <p className="ds-help">
            Provider cooldowns and dispatch pauses can delay execution.
          </p>
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
    onSuccess: () => {
      setConfirming(false)
      void client.invalidateQueries({ queryKey: ['jobs'] })
      void client.invalidateQueries({ queryKey: ['job-activity'] })
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
  const stage = JobActivityLogMetadataSchema.safeParse(log.metadata)
  const activity = stage.success ? stage.data.activity : undefined
  const previous = stage.success ? stage.data.previousActivity : undefined
  const count = activity ? jobActivityCount(activity) : null
  return (
    <li className="ops-log-entry" data-level={log.level}>
      <time className="ds-muted ds-num" dateTime={log.createdAt}>
        {formatDateTime(log.createdAt)}
      </time>
      <Status
        state={
          log.level === 'error'
            ? 'failed'
            : log.level === 'warn'
              ? 'attention'
              : 'done'
        }
      >
        {log.level === 'error'
          ? 'Error'
          : log.level === 'warn'
            ? 'Warning'
            : 'Info'}
      </Status>
      <span className="ops-log-message">{log.message}</span>
      <span className="ds-actions">
        {log.benignReview ? (
          <span className="ds-muted">
            Marked benign · {formatDateTime(log.benignReview.reviewedAt)}
          </span>
        ) : log.canMarkBenign ? (
          <>
            <Button
              size="xs"
              disabled={review.isPending}
              feedback={mutationFeedback(review, {
                pending: 'Marking benign…',
                success: 'Marked benign',
                error: 'Review unconfirmed',
              })}
              onClick={() =>
                confirming ? review.mutate() : setConfirming(true)
              }
            >
              {confirming ? 'Confirm benign' : 'Mark benign'}
            </Button>
            {confirming && (
              <Button
                size="xs"
                variant="ghost"
                disabled={review.isPending}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            )}
          </>
        ) : null}
      </span>
      <div className="ops-log-detail">
        {(count || previous) && (
          <KeyValues
            items={[
              ...(count ? [{ label: 'Progress', value: count }] : []),
              ...(previous
                ? [
                    {
                      label: 'Previous stage',
                      value: `${jobActivityLabel(previous)} · ${formatElapsed(previous.durationMs)}`,
                    },
                  ]
                : []),
            ]}
          />
        )}
        {LegacyJobContextSchema.safeParse(log.metadata).success && (
          <p className="ds-help">
            Original batch context, not an item-specific event.
          </p>
        )}
        {confirming && (
          <p className="ds-help">
            Only this error will be dismissed. No retry, limit reset or rule for
            future errors.
          </p>
        )}
        {review.isError && (
          <p role="alert" className="ops-danger">
            {review.error.message}
          </p>
        )}
        {[...requestErrors].map(([identity, entry]) => (
          <JobRequestError key={identity} error={entry} />
        ))}
        {error ? (
          <pre className="ops-pre">
            {[
              error.stack ?? `${error.name}: ${error.message}`,
              ...error.causes.map(
                (cause) =>
                  `Caused by: ${cause.stack ?? `${cause.name}: ${cause.message}`}`,
              ),
            ].join('\n\n')}
          </pre>
        ) : log.level === 'error' ? (
          <p className="ds-help">
            No error details were recorded for this entry.
          </p>
        ) : null}
        {diagnosticMetadata.success &&
          diagnosticMetadata.data.diagnostics !== null && (
            <details
              className="ops-disclosure"
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
