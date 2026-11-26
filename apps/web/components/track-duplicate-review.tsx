'use client'

import { ReadButton } from '@/components/read-button'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { LibraryChangeKindSchema } from '@repo/schemas/library-changes'
import {
  DuplicateReviewConfidenceSchema,
  DuplicateReviewDecisionSchema,
  type DuplicateReviewPair,
  type TrackDuplicateGroup,
} from '@repo/schemas/track-duplicates'
import { KeyValues } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import {
  FilterLine,
  Select,
  ToolbarCount,
} from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableState,
} from '@repo/ui/components/ui/table'
import {
  formatCount,
  formatDate,
  formatItemCount,
  formatTrackLength,
} from '@repo/ui/lib/format'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { detailPageHref } from '@/utils/detail-inspector'
import { clientQueryDefaults } from '@/utils/query-cache'
import {
  defaultDuplicateReviewFilters,
  duplicateReviewKey,
  duplicateReviewPageSize,
  loadDuplicateReview,
  loadTrackDuplicates,
  trackDuplicatesKey,
  type DuplicateReviewFilters,
} from '@/utils/track-duplicates'
import { libraryChangesPaths } from './library-changes'
import { ResultButton } from './result-feedback'
import { useConfig } from './providers'
import {
  SecondaryCellDetails,
  SecondaryTableScroll,
  SecondaryTableSearch,
  SecondaryTableToolbar,
  SecondaryVirtualRows,
  useTableColumns,
  type TableColumn,
} from './secondary-table'

const kindLabels = { track: 'Track', album: 'Album', artist: 'Artist' }
const kindFilterLabels = { track: 'Tracks', album: 'Albums', artist: 'Artists' }
const decisionLabels = {
  applied: 'Applied',
  held: 'Held',
  grouped: 'Already grouped',
}
const confidenceLabels = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
  excluded: 'Excluded',
}

const title = 'Duplicate review'
const columns: readonly TableColumn[] = [
  { key: 'records', label: 'Records', width: 204, fill: true },
  { key: 'outcome', label: 'Outcome', width: 136 },
  { key: 'type', label: 'Type', width: 72 },
]
// The one table's two-line rows (.ds-table[data-rows='two']).
const twoLineRowHeight = 44

const pairKey = (pair: DuplicateReviewPair) =>
  JSON.stringify([pair.kind, pair.leftId, pair.rightId])

const pairOutcome = (pair: DuplicateReviewPair) =>
  pair.undone ? 'Applied · Undone' : decisionLabels[pair.decision]

function describePair(pair: DuplicateReviewPair) {
  return `${pairOutcome(pair)} · ${confidenceLabels[pair.confidence]}`
}

function detailText(pair: DuplicateReviewPair, key: string) {
  const value = pair.details[key]
  return typeof value === 'string' && value ? value : undefined
}

function describeEvidence(pair: DuplicateReviewPair) {
  const durations = (key: string) => {
    const value = pair.details[key]
    if (!Array.isArray(value)) return undefined
    return value
      .filter((seconds) => typeof seconds === 'number')
      .map((seconds) => formatTrackLength(seconds * 1_000))
      .join(', ')
  }
  const count = (key: string) => {
    const value = pair.details[key]
    return typeof value === 'number' ? formatCount(value) : undefined
  }
  return [
    { label: 'Left credits', value: detailText(pair, 'leftCredits') },
    { label: 'Right credits', value: detailText(pair, 'rightCredits') },
    { label: 'Left album', value: detailText(pair, 'leftAlbum') },
    { label: 'Right album', value: detailText(pair, 'rightAlbum') },
    { label: 'Left durations', value: durations('leftDurations') },
    { label: 'Right durations', value: durations('rightDurations') },
    { label: 'Left track count', value: count('leftTrackCount') },
    { label: 'Right track count', value: count('rightTrackCount') },
    { label: 'Shared identifier', value: detailText(pair, 'sharedIdentifier') },
  ].filter(({ value }) => value)
}

function ReviewRecordLink({
  kind,
  id,
  title,
}: {
  kind: DuplicateReviewPair['kind']
  id: string
  title: string
}) {
  return (
    <Link
      className="underline"
      href={detailPageHref(
        { kind, id },
        new URLSearchParams({ tab: 'sources' }),
      )}
      prefetch={false}
    >
      {title}
    </Link>
  )
}

function ReviewPairEvidence({ pair }: { pair: DuplicateReviewPair }) {
  const {
    kind,
    leftId,
    rightId,
    leftTitle,
    rightTitle,
    decision,
    targetId,
    targetTitle,
    changeId,
    undone,
    reason,
    evidence,
  } = pair
  const showPairLinks = decision !== 'applied' || undone
  const savedChanges = pair.details.priorChanges
  const priorChanges = Array.isArray(savedChanges)
    ? savedChanges.filter((id) => typeof id === 'string')
    : []
  return (
    <div>
      <strong>{describePair(pair)}</strong>
      <KeyValues
        items={[
          {
            label: 'Left record',
            value: showPairLinks ? (
              <ReviewRecordLink kind={kind} id={leftId} title={leftTitle} />
            ) : (
              leftTitle
            ),
          },
          {
            label: 'Right record',
            value: showPairLinks ? (
              <ReviewRecordLink kind={kind} id={rightId} title={rightTitle} />
            ) : (
              rightTitle
            ),
          },
          ...(targetId
            ? [
                {
                  label: undone ? 'Originally kept' : 'Kept record',
                  value: (
                    <ReviewRecordLink
                      kind={kind}
                      id={targetId}
                      title={targetTitle ?? 'Open record'}
                    />
                  ),
                },
              ]
            : []),
          ...(reason ? [{ label: 'Reason', value: reason }] : []),
          ...(evidence.length
            ? [
                {
                  label: 'Evidence',
                  value: evidence.map((line, index) => (
                    <div key={index}>{line}</div>
                  )),
                },
              ]
            : []),
          ...describeEvidence(pair),
        ]}
      />
      {changeId && (
        <Button size="xs" variant="link" asChild>
          <Link
            href={{ pathname: libraryChangesPaths[kind], query: { changeId } }}
            prefetch={false}
          >
            {kindFilterLabels[kind]} History
          </Link>
        </Button>
      )}
      {priorChanges.map((id, index) => (
        <Button key={id} size="xs" variant="link" asChild>
          <Link
            href={{
              pathname: libraryChangesPaths[kind],
              query: { changeId: id },
            }}
            prefetch={false}
          >
            {priorChanges.length === 1
              ? 'Earlier merge'
              : `Earlier merge ${index + 1}`}
          </Link>
        </Button>
      ))}
    </div>
  )
}

function ReviewedGroupEvidence({
  groupId,
  trackId,
}: {
  groupId: string
  trackId: string
}) {
  const { apiBaseUrl } = useConfig()
  const query = useQuery({
    queryKey: trackDuplicatesKey(trackId),
    queryFn: ({ signal }) => loadTrackDuplicates(apiBaseUrl, trackId, signal),
    ...clientQueryDefaults,
    retry: false,
  })
  if (query.isPending) return 'Loading review evidence…'
  if (query.isError && !query.data)
    return (
      <>
        Could not load review evidence.
        <ReadButton size="xs" read={() => query.refetch()}>
          Retry
        </ReadButton>
      </>
    )
  const pairs = query.data?.items.find(
    (group) => group.id === groupId,
  )?.reviewPairs
  return pairs?.length
    ? pairs.map((item) => (
        <ReviewPairEvidence key={pairKey(item)} pair={item} />
      ))
    : 'No saved pairs in this suggestion.'
}

/** The saved decisions apply to pairs, including within a larger live group. */
export function TrackDuplicateReviewedPairs({
  group,
}: {
  group: Pick<TrackDuplicateGroup, 'id' | 'memberIds' | 'reviewSummary'>
}) {
  const { reviewSummary } = group
  const [trackId] = group.memberIds
  if (!reviewSummary || !trackId) return null
  const label = formatItemCount(reviewSummary.pairCount, {
    one: 'reviewed pair',
    other: 'reviewed pairs',
  })
  const decision = reviewSummary.decision
    ? decisionLabels[reviewSummary.decision]
    : 'Mixed outcomes'
  const confidence = reviewSummary.confidence
    ? confidenceLabels[reviewSummary.confidence]
    : 'Mixed confidence'
  const text = `${label} · ${decision} · ${confidence}`
  return (
    <SecondaryCellDetails
      label={`Review evidence for ${text}`}
      buttonText={text}
    >
      {() => <ReviewedGroupEvidence groupId={group.id} trackId={trackId} />}
    </SecondaryCellDetails>
  )
}

export function TrackDuplicateReviewSummary({
  open,
  onToggle,
}: {
  open: boolean
  onToggle: () => void
}) {
  const { apiBaseUrl } = useConfig()
  const filters = defaultDuplicateReviewFilters
  const query = useQuery({
    queryKey: [...duplicateReviewKey(filters), 1],
    queryFn: ({ signal }) =>
      loadDuplicateReview(
        apiBaseUrl,
        { ...filters, page: 1, size: duplicateReviewPageSize },
        signal,
      ),
    ...clientQueryDefaults,
    retry: false,
  })
  const review = query.data?.review
  return (
    <FilterLine>
      <ToolbarCount>
        {review ? (
          <>
            Reviewed{' '}
            <time dateTime={review.reviewedAt}>
              {formatDate(review.reviewedAt)}
            </time>
            {' · '}
            {formatItemCount(review.mergeCount, {
              one: 'merge',
              other: 'merges',
            })}{' '}
            applied
          </>
        ) : query.isError ? (
          'Could not load saved review.'
        ) : query.isPending ? (
          'Loading saved review…'
        ) : (
          'No saved review.'
        )}
      </ToolbarCount>
      {(review || open) && (
        <ResultButton
          control="duplicate-review-view"
          size="xs"
          onClick={onToggle}
        >
          {open ? 'Back to suggestions' : 'View review'}
        </ResultButton>
      )}
      {query.isError && !query.data && (
        <ReadButton size="xs" read={() => query.refetch()}>
          Retry
        </ReadButton>
      )}
    </FilterLine>
  )
}

function ReviewRow({
  pair,
  index,
}: {
  pair: DuplicateReviewPair
  index: number
}) {
  const leftCredits = detailText(pair, 'leftCredits')
  const rightCredits = detailText(pair, 'rightCredits')
  const leftLabel = leftCredits
    ? `${pair.leftTitle} by ${leftCredits}`
    : pair.leftTitle
  const rightLabel = rightCredits
    ? `${pair.rightTitle} by ${rightCredits}`
    : pair.rightTitle
  return (
    <TableRow aria-rowindex={index + 2}>
      <TableCell sticky={0} stickyEdge>
        <span className="ds-cell-id">
          <SecondaryCellDetails
            label={`Review evidence for ${leftLabel} and ${rightLabel}`}
            icon="eye"
          >
            <ReviewPairEvidence pair={pair} />
          </SecondaryCellDetails>
          <span className="ds-cell-two">
            <span className="ds-cell-title" title={leftLabel}>
              {pair.leftTitle}
            </span>
            <span className="ds-cell-sub" title={rightLabel}>
              {pair.rightTitle}
            </span>
          </span>
        </span>
      </TableCell>
      <TableCell>
        <span className="ds-cell-two">
          <span className="ds-cell-title">{pairOutcome(pair)}</span>
          <span className="ds-cell-sub">
            {confidenceLabels[pair.confidence]}
          </span>
        </span>
      </TableCell>
      <TableCell>{kindLabels[pair.kind]}</TableCell>
    </TableRow>
  )
}

export function useTrackDuplicateReview(active: boolean) {
  const { apiBaseUrl } = useConfig()
  const [filters, setFilters] = useState(defaultDuplicateReviewFilters)
  const [draft, setDraft] = useState('')
  const [search, setSearch] = useState('')
  const query = { ...filters, q: search || undefined }
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(draft.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [draft])
  const queryKey = duplicateReviewKey(query)
  const page = useVirtualTable({
    queryKey,
    enabled: active,
    pageSize: duplicateReviewPageSize,
    rowHeight: twoLineRowHeight,
    loadPage: (page, size, signal) =>
      loadDuplicateReview(apiBaseUrl, { ...query, page, size }, signal),
  })
  function update(next: DuplicateReviewFilters) {
    setFilters((previous) => ({ ...previous, ...next }))
  }
  function reset() {
    setFilters(defaultDuplicateReviewFilters)
    setDraft('')
    setSearch('')
  }
  return {
    identity: JSON.stringify(queryKey),
    page,
    filters,
    draft,
    setDraft,
    update,
    reset,
  }
}

export function TrackDuplicateReview({
  model,
}: {
  model: ReturnType<typeof useTrackDuplicateReview>
}) {
  const { page, filters, draft, setDraft, update } = model
  const table = useTableColumns('duplicate-review', columns)
  const layout = table.layout(columns.map(({ key }) => key))
  return (
    <>
      <SecondaryTableToolbar
        search={
          <SecondaryTableSearch
            label="Search reviewed pairs"
            placeholder="Search names or artists"
            value={draft}
            maxLength={200}
            onChange={setDraft}
          />
        }
        filters={
          <>
            <Select
              aria-label="Review outcome"
              value={filters.decision ?? ''}
              onChange={(event) =>
                update({
                  decision: DuplicateReviewDecisionSchema.safeParse(
                    event.target.value,
                  ).data,
                })
              }
            >
              {Object.entries(decisionLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
              <option value="">All outcomes</option>
            </Select>
            <Select
              aria-label="Review record type"
              value={filters.kind ?? ''}
              onChange={(event) =>
                update({
                  kind: LibraryChangeKindSchema.safeParse(event.target.value)
                    .data,
                })
              }
            >
              <option value="">All record types</option>
              {Object.entries(kindFilterLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Review confidence"
              value={filters.confidence ?? ''}
              onChange={(event) =>
                update({
                  confidence: DuplicateReviewConfidenceSchema.safeParse(
                    event.target.value,
                  ).data,
                })
              }
            >
              <option value="">All confidence levels</option>
              {Object.entries(confidenceLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </>
        }
        count={
          page.hasTotal
            ? formatItemCount(page.total, {
                one: 'reviewed pair',
                other: 'reviewed pairs',
              })
            : undefined
        }
      />
      {page.isError && (
        <Notice
          tone="danger"
          action={
            <ReadButton size="xs" read={page.retry}>
              Retry
            </ReadButton>
          }
        >
          Could not load reviewed pairs.
        </Notice>
      )}
      <SecondaryTableScroll
        ref={page.scroller}
        onScroll={page.onScroll}
        aria-label={title}
        role="region"
        aria-busy={page.isFetching}
      >
        <table
          className="ds-table"
          aria-label={title}
          data-rows="two"
          aria-rowcount={page.hasTotal ? page.total + 1 : undefined}
          {...layout.table}
        >
          {layout.colgroup}
          <TableHeader>
            <TableRow>
              {columns.map(({ key, label }) => (
                <TableHead
                  key={key}
                  sticky={key === 'records' ? 0 : undefined}
                  stickyEdge={key === 'records'}
                  resizer={table.resizer(key)}
                >
                  {label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.hasTotal && !page.total && (
              <TableState colSpan={columns.length}>
                No reviewed pairs match.
              </TableState>
            )}
            <SecondaryVirtualRows
              window={page}
              colSpan={columns.length}
              renderRow={(pair, index) => (
                <ReviewRow key={pairKey(pair)} pair={pair} index={index} />
              )}
            />
          </TableBody>
        </table>
      </SecondaryTableScroll>
    </>
  )
}
