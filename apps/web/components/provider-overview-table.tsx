'use client'

import Link from 'next/link'
import type {
  ProviderOverviewItem,
  ProviderSummary,
} from '@repo/schemas/provider'
import { Skeleton } from '@repo/ui/components/ds/feedback'
import { Meter } from '@repo/ui/components/ds/meter'
import { Count, EmptyValue, ProviderMark } from '@repo/ui/components/ds/pill'
import { Status } from '@repo/ui/components/ds/status'
import { Sparkline } from '@repo/ui/components/ds/trend-chart'
import { Button } from '@repo/ui/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui/components/ui/table'
import {
  formatAge,
  formatCount,
  formatDateTime,
  formatUntil,
} from '@repo/ui/lib/format'
import {
  activeCooldownUntil,
  budgetShare,
  connectionStatus,
  providerHref,
  providerJobsHref,
  providerMarkText,
  providerPurpose,
  queueStatus,
  runsOnLabel,
} from '@/utils/provider-overview'
import {
  ProviderCooldownConfirm,
  useProviderCooldown,
} from './provider-cooldown'
import {
  ProviderDispatchActions,
  ProviderDispatchReview,
  useProviderDispatch,
} from './provider-job-dispatch'
import { useTableWidths } from './secondary-table'

type Column = {
  key: string
  label: string
  width: number
  end?: boolean
  fill?: boolean
}

const columns: readonly Column[] = [
  { key: 'provider', label: 'Provider', width: 240, fill: true },
  { key: 'connection', label: 'Connection', width: 128 },
  { key: 'queue', label: 'Queue', width: 196 },
  { key: 'queued', label: 'Queued', width: 72, end: true },
  { key: 'running', label: 'Running', width: 72, end: true },
  { key: 'attention', label: 'Needs attention', width: 112, end: true },
  { key: 'last', label: 'Last success', width: 104 },
  { key: 'requests', label: 'Requests · 24h', width: 104 },
  { key: 'budget', label: 'Budget', width: 112 },
  { key: 'runsOn', label: 'Runs on', width: 148 },
  { key: 'actions', label: 'Actions', width: 184, end: true },
]

const groups: { key: ProviderOverviewItem['group']; label: string }[] = [
  { key: 'account', label: 'Accounts' },
  { key: 'metadata', label: 'Metadata' },
]

/** Every provider in one table, grouped into accounts and metadata. */
export function ProviderOverviewTable({
  items,
  summaries,
  loading = false,
  now = new Date(),
}: {
  items: readonly ProviderOverviewItem[]
  summaries: readonly ProviderSummary[]
  loading?: boolean
  now?: Date
}) {
  const widths = useTableWidths('provider-overview', columns)
  const layout = widths.layout(
    columns.map((column) =>
      column.key === 'actions' ? column.width : column.key,
    ),
  )
  return (
    <Table aria-label="Providers" rows="two" {...layout.table}>
      {layout.colgroup}
      <TableHeader>
        <TableRow>
          {columns.map((column, index) => (
            <TableHead
              key={column.key}
              align={column.end ? 'end' : undefined}
              sticky={index === 0 ? 0 : undefined}
              stickyEdge={index === 0}
              resizer={
                column.key === 'actions'
                  ? undefined
                  : widths.resizer(column.key)
              }
            >
              {column.key === 'actions' ? (
                <span className="sr-only">{column.label}</span>
              ) : (
                column.label
              )}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {loading
          ? Array.from({ length: 6 }, (_, index) => (
              <TableRow key={index} aria-hidden="true">
                <TableCell colSpan={columns.length}>
                  <Skeleton className="providers-row-skeleton" />
                </TableCell>
              </TableRow>
            ))
          : groups.map((group) => {
              const rows = items.filter((item) => item.group === group.key)
              if (!rows.length) return null
              return [
                <TableRow key={group.key} group>
                  <TableCell colSpan={columns.length}>{group.label}</TableCell>
                </TableRow>,
                ...rows.map((item) => (
                  <ProviderOverviewRow
                    key={item.id}
                    item={item}
                    summary={summaries.find(
                      (summary) => summary.id === item.id,
                    )}
                    now={now}
                  />
                )),
              ]
            })}
      </TableBody>
    </Table>
  )
}

function JobCount({
  id,
  count,
  status,
  label,
}: {
  id: string
  count: number
  status: 'queued' | 'running' | 'attention'
  label: string
}) {
  if (count === 0) return <span className="ds-muted">0</span>
  return (
    <Link
      href={providerJobsHref(id, status)}
      aria-label={`${formatCount(count)} ${label}`}
    >
      {status === 'attention' ? (
        <Count tone="danger">{formatCount(count)}</Count>
      ) : (
        formatCount(count)
      )}
    </Link>
  )
}

function ProviderOverviewRow({
  item,
  summary,
  now,
}: {
  item: ProviderOverviewItem
  summary: ProviderSummary | undefined
  now: Date
}) {
  const cooldown = useProviderCooldown(item.id)
  const dispatch = useProviderDispatch(
    summary ?? {
      id: item.id,
      displayName: item.name,
      supportsJobDispatchControl: false,
    },
  )
  const connection = connectionStatus(item.connection)
  const queue = queueStatus(item.queue, now)
  const cooldownUntil = activeCooldownUntil(item.queue, now)
  const requests = item.requests24h.reduce((sum, count) => sum + count, 0)
  const purpose = providerPurpose(item)
  const confirming =
    cooldown.confirming !== null ||
    cooldown.clear.isError ||
    cooldown.clear.isSuccess ||
    dispatch.reviewing !== null ||
    dispatch.update.isError ||
    dispatch.update.isSuccess ||
    dispatch.status.isError
  return (
    <>
      <TableRow>
        <TableCell sticky={0} stickyEdge>
          <span className="ds-cell-id">
            <ProviderMark name={item.name}>
              {providerMarkText(item.name)}
            </ProviderMark>
            <span className="ds-cell-two">
              <Link className="ds-cell-title" href={providerHref(item.id)}>
                {item.name}
              </Link>
              <span className="ds-cell-sub" title={purpose}>
                {purpose}
              </span>
            </span>
          </span>
        </TableCell>
        <TableCell>
          <Status state={connection.state} title={connection.title}>
            {connection.label}
          </Status>
        </TableCell>
        <TableCell>
          <span className="ds-cell-two">
            <Status state={queue.state} title={queue.title}>
              {queue.label}
            </Status>
            {item.queue.detail && (
              <span className="ds-cell-sub" title={item.queue.detail}>
                {item.queue.detail}
              </span>
            )}
          </span>
        </TableCell>
        <TableCell align="end">
          <JobCount
            id={item.id}
            count={item.jobs.queued}
            status="queued"
            label="queued jobs"
          />
        </TableCell>
        <TableCell align="end">
          <JobCount
            id={item.id}
            count={item.jobs.running}
            status="running"
            label="running jobs"
          />
        </TableCell>
        <TableCell align="end">
          <JobCount
            id={item.id}
            count={item.jobs.attention}
            status="attention"
            label="jobs need attention"
          />
        </TableCell>
        <TableCell>
          {item.lastSuccessAt ? (
            <span title={formatDateTime(item.lastSuccessAt)}>
              {formatAge(item.lastSuccessAt, now)}
            </span>
          ) : (
            <Status state="never" />
          )}
        </TableCell>
        <TableCell>
          {requests > 0 ? (
            <Sparkline
              values={item.requests24h}
              label={`${formatCount(requests)} requests in the last 24 hours`}
            />
          ) : (
            <EmptyValue />
          )}
        </TableCell>
        <TableCell>
          {item.budget ? (
            <div
              className="ds-progress"
              title={`${formatCount(item.budget.used)} of ${formatCount(item.budget.limit)} requests ${item.budget.period === 'day' ? 'today' : 'this hour'} · resets ${formatUntil(item.budget.resetsAt, now)}`}
            >
              <Meter
                value={budgetShare(item.budget)}
                tone={budgetShare(item.budget) > 80 ? 'attention' : undefined}
              />
              <span>{budgetShare(item.budget)}%</span>
            </div>
          ) : (
            <span className="ds-muted">No limit</span>
          )}
        </TableCell>
        <TableCell>{runsOnLabel(item)}</TableCell>
        <TableCell align="end">
          <span className="ds-cell-actions">
            {cooldownUntil && !cooldown.confirming && (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => cooldown.start(cooldownUntil)}
              >
                Clear cooldown
              </Button>
            )}
            <ProviderDispatchActions dispatch={dispatch} compact />
          </span>
        </TableCell>
      </TableRow>
      {confirming && (
        <TableRow child>
          <TableCell colSpan={columns.length} className="providers-row-notes">
            <ProviderCooldownConfirm cooldown={cooldown} />
            <ProviderDispatchReview dispatch={dispatch} />
          </TableCell>
        </TableRow>
      )}
    </>
  )
}
