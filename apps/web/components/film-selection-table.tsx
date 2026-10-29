'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  type BrowseFilter,
  type BrowseRange,
  type BrowseValues,
  filmBrowseFields,
  albumBrowseFields,
  formatBrowseValue,
  getBrowseValues,
} from '@repo/schemas/browse'
import {
  lastScrapedField,
  ProviderFreshnessFilterSchema,
  QueueFilmSelectionSchema,
  type FilmSelectionItem,
  type ProviderFreshnessFilter,
} from '@repo/schemas/film-selection'
import type { AlbumSelectionItem } from '@repo/schemas/album-selection'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import type { ProviderSummary } from '@repo/schemas/provider'
import { Button } from '@repo/ui/components/ui/button'
import { TableScroll, TableState } from '@repo/ui/components/ui/table'
import { useConfig } from './providers'
import { FilmProviderSelection } from './film-provider-selection'
import { BrowseFilterChips, RangeEditor } from './browse-controls'
import BrowseFilterAutocomplete from './browse-filter-autocomplete'
import { useFilmSelection } from '@/hooks/useFilmSelection'
import { useInfiniteTableScroll } from '@/hooks/useInfiniteTableScroll'
import { updateJobSelection } from '@/utils/job-selection'
import { dispatchFilmSelection } from '@/utils/film-selection'
import { fetchApiData } from '@/utils/api'
import { scopedHref, type MediaScope } from '@/utils/media-scope'

type Props = {
  providers: ProviderSummary[]
  mediaType?: MediaScope
}

export function updateProviderFreshness(
  filters: ProviderFreshnessFilter[],
  provider: string,
  value: string,
): ProviderFreshnessFilter[] {
  const remaining = filters.filter((filter) => filter.provider !== provider)
  if (value === 'all') return remaining
  const filter = ProviderFreshnessFilterSchema.parse(
    value === 'never' || value === 'failed' || value === 'unscraped'
      ? { provider, mode: value }
      : { provider, mode: 'older', olderThanDays: Number(value) },
  )
  return [...remaining, filter]
}

export default function FilmSelectionTable(props: Props) {
  if (!props.providers.length)
    return (
      <p className="muted">
        No metadata providers are available for this library.
      </p>
    )
  return <SelectionTable key={props.mediaType} {...props} />
}

function SelectionTable({ providers, mediaType = 'film' }: Props) {
  const plural = mediaType === 'album' ? 'albums' : 'films'
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [provider, setProvider] = useState('')
  const [freshness, setFreshness] = useState<ProviderFreshnessFilter[]>([])
  const [selectedProviders, setSelectedProviders] = useState<string[]>([])
  const [q, setQ] = useState('')
  const [draft, setDraft] = useState('')
  const [filters, setFilters] = useState<BrowseFilter[]>([])
  const [ranges, setRanges] = useState<BrowseRange[]>([])
  const [sortBy, setSortBy] = useState('dateAdded')
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc')
  const [columns, setColumns] = useState([
    'title',
    ...(mediaType === 'album' ? ['artist'] : []),
    'dateAdded',
  ])
  const [selected, setSelected] = useState<string[]>([])
  const [anchor, setAnchor] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [progress, setProgress] = useState(0)
  const all = useRef<HTMLInputElement>(null)
  const params = new URLSearchParams({
    q,
    sortBy,
    direction,
    filters: JSON.stringify(filters),
    ranges: JSON.stringify(ranges),
    freshness: JSON.stringify(freshness),
  })
  if (sortBy === 'lastScrapedAt') params.set('provider', provider)
  const { fields, facets, films } = useFilmSelection(
    params.toString(),
    mediaType,
  )
  const available =
    fields.data ??
    (mediaType === 'album' ? albumBrowseFields : filmBrowseFields)
  const visible = columns.flatMap((key) =>
    available.filter((field) => field.key === key),
  )
  const columnWidths = visible.map((field) =>
    field.key === 'title' ? 160 : field.type === 'text' ? 120 : 88,
  )
  const tableWidth =
    28 +
    columnWidths.reduce((total, width) => total + width, 0) +
    providers.length * 110
  const items =
    films.data?.pages.flatMap<FilmSelectionItem | AlbumSelectionItem>(
      (page) => page.items,
    ) ?? []
  const ids = items.map((item) => item.id)
  const allChecked = ids.length > 0 && ids.every((id) => selected.includes(id))
  const launchProviders = providers
    .filter(
      (item) =>
        selectedProviders.includes(item.id) &&
        !item.safety?.halted &&
        item.secrets.every((field) => !field.required || field.configured),
    )
    .map((item) => item.id)
  const operations = selected.length * launchProviders.length
  const confirmationKey = JSON.stringify([selected, launchProviders, freshness])
  const [confirmedKey, setConfirmedKey] = useState('')
  const broadConfirmed = confirmed && confirmedKey === confirmationKey
  const [batchId, setBatchId] = useState('')
  const queue = useMutation({
    mutationFn: async () => {
      const batch = crypto.randomUUID()
      setBatchId(batch)
      return dispatchFilmSelection(
        selected,
        (mediaItemIds) =>
          fetchApiData(
            apiBaseUrl,
            `/api/v1/scrape/jobs/${plural}`,
            EnrichmentResultSchema,
            {
              method: 'POST',
              body: JSON.stringify(
                QueueFilmSelectionSchema.parse({
                  providers: launchProviders,
                  mediaItemIds,
                  batchId: batch,
                  freshness: freshness.filter((filter) =>
                    launchProviders.includes(filter.provider),
                  ),
                  confirmBroadRun: operations > 5 && broadConfirmed,
                }),
              ),
            },
          ),
        setProgress,
      )
    },
    onMutate: () => {
      setProgress(0)
    },
    onSuccess: (result) => {
      setSelected((current) =>
        current.filter((id) => !result.completed.includes(id)),
      )
      setConfirmed(false)
    },
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: ['jobs'] })
      await client.invalidateQueries({ queryKey: ['job-activity'] })
      await client.invalidateQueries({ queryKey: [`${mediaType}-selection`] })
    },
  })
  const { scroller, sentinel } = useInfiniteTableScroll({
    enabled:
      films.hasNextPage &&
      !films.isFetching &&
      !films.isError &&
      !queue.isPending,
    fetchNextPage: films.fetchNextPage,
    resetKey: params.toString(),
  })
  const refetchSelection = films.refetch
  useEffect(() => {
    if (queue.isPending) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible')
        void refetchSelection({ cancelRefetch: false })
    }, 10000)
    return () => window.clearInterval(timer)
  }, [refetchSelection, queue.isPending])
  useEffect(() => {
    if (all.current)
      all.current.indeterminate =
        !allChecked && ids.some((id) => selected.includes(id))
  }, [allChecked, ids, selected])
  function clear() {
    setSelected([])
    setAnchor(null)
    setConfirmed(false)
  }
  function changeSelection(next: string[]) {
    setSelected(next)
    setConfirmed(false)
  }
  function sort(key: string, nextProvider = '') {
    setSortBy(key)
    setProvider(nextProvider)
    setDirection(
      sortBy === key && provider === nextProvider && direction === 'asc'
        ? 'desc'
        : 'asc',
    )
    clear()
  }
  return (
    <div className="film-selection-workspace">
      <fieldset disabled={queue.isPending} className="film-selection-controls">
        <div className="flex flex-wrap items-end gap-3">
          <BrowseFilterAutocomplete
            options={facets.data ?? []}
            items={[]}
            titlesLoading={false}
            titlesError={false}
            placeholder={`Search ${plural} or add a filter`}
            value={draft}
            onValueChange={setDraft}
            onAddFilter={(filter) => {
              setFilters([
                ...filters.filter(
                  (f) => f.field !== filter.field || f.value !== filter.value,
                ),
                filter,
              ])
              setDraft('')
              clear()
            }}
            onApplyText={(value) => {
              setQ(value)
              clear()
            }}
            onOpenItem={() => {}}
          />
          <RangeEditor
            fields={available}
            ranges={ranges}
            onChange={(next) => {
              setRanges(next)
              clear()
            }}
          />
          <details className="toolbar-popover">
            <summary>Columns</summary>
            <div className="popover-panel max-h-80 overflow-auto">
              {available.map((field) => (
                <label className="check-label" key={field.key}>
                  <input
                    type="checkbox"
                    checked={columns.includes(field.key)}
                    disabled={
                      field.key === 'title' ||
                      (mediaType === 'album' && field.key === 'artist')
                    }
                    onChange={(event) =>
                      setColumns(
                        event.target.checked
                          ? [...columns, field.key]
                          : columns.filter((key) => key !== field.key),
                      )
                    }
                  />
                  {field.label}
                </label>
              ))}
            </div>
          </details>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {q && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setQ('')
                setDraft('')
                clear()
              }}
            >
              Clear search: {q}
            </Button>
          )}
          <BrowseFilterChips
            filters={filters}
            fields={available}
            onChange={(next) => {
              setFilters(next)
              clear()
            }}
          />
          {ranges.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setRanges([])
                clear()
              }}
            >
              Clear {ranges.length} ranges
            </Button>
          )}
        </div>
      </fieldset>
      <p className="muted">
        {films.data?.pages[0]?.totalCount.toLocaleString() ?? '…'} {plural} ·{' '}
        {selected.length} selected. Shift-click for a range.
      </p>
      {freshness.length > 0 && (
        <p className="muted">
          Match all provider filters. Older-than includes no successful scrape.
        </p>
      )}
      {films.isError && items.length > 0 && !films.isFetchNextPageError && (
        <p role="alert">
          Could not load {plural}.{' '}
          <button type="button" onClick={() => films.refetch()}>
            Retry
          </button>
        </p>
      )}
      {facets.isError && (
        <p role="alert">
          Filter suggestions unavailable.{' '}
          <button type="button" onClick={() => facets.refetch()}>
            Retry
          </button>
        </p>
      )}
      <TableScroll
        ref={scroller}
        className="film-selection-scroll"
        aria-label={`${mediaType === 'album' ? 'Album' : 'Film'} selection`}
        role="region"
        aria-busy={films.isFetching}
      >
        <table
          className="compact-table film-selection-table"
          style={{ tableLayout: 'fixed', width: '100%', minWidth: tableWidth }}
          aria-label={`${mediaType === 'album' ? 'Albums' : 'Films'} to scrape`}
        >
          <colgroup>
            <col style={{ width: 28 }} />
            {visible.map((field, index) => (
              <col key={field.key} style={{ width: columnWidths[index] }} />
            ))}
            {providers.map((item) => (
              <col key={`scraped-${item.id}`} style={{ width: 110 }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="table-selection-cell" scope="col">
                <input
                  ref={all}
                  type="checkbox"
                  aria-label={`Select all loaded ${plural}`}
                  checked={allChecked}
                  disabled={queue.isPending || !ids.length}
                  onChange={(event) => {
                    changeSelection(
                      event.target.checked
                        ? [...new Set([...selected, ...ids])]
                        : selected.filter((id) => !ids.includes(id)),
                    )
                    setAnchor(null)
                  }}
                />
              </th>
              {visible.map((field) => (
                <th
                  scope="col"
                  key={field.key}
                  aria-sort={
                    sortBy === field.key
                      ? direction === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                >
                  <button
                    type="button"
                    disabled={queue.isPending}
                    onClick={() => sort(field.key)}
                  >
                    {field.label}
                    {sortBy === field.key
                      ? direction === 'asc'
                        ? ' ↑'
                        : ' ↓'
                      : ''}
                  </button>
                </th>
              ))}
              {providers.map((item) => {
                const filter = freshness.find(
                  (entry) => entry.provider === item.id,
                )
                const sorted =
                  sortBy === 'lastScrapedAt' && provider === item.id
                return (
                  <th
                    scope="col"
                    key={`scraped-${item.id}`}
                    aria-sort={
                      sorted
                        ? direction === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                  >
                    <div className="grid min-w-0 gap-1">
                      <button
                        className="truncate text-left"
                        title={`${item.displayName} - Last successful scrape`}
                        type="button"
                        disabled={queue.isPending}
                        onClick={() => sort('lastScrapedAt', item.id)}
                      >
                        {item.displayName} · Last scraped
                        {sorted ? (direction === 'asc' ? ' ↑' : ' ↓') : ''}
                      </button>
                      <select
                        className="w-full min-w-0 border bg-background py-1 text-xs font-normal"
                        aria-label={`${item.displayName} freshness`}
                        disabled={queue.isPending}
                        value={
                          filter?.mode === 'older'
                            ? String(filter.olderThanDays)
                            : (filter?.mode ?? 'all')
                        }
                        onChange={(event) => {
                          setFreshness(
                            updateProviderFreshness(
                              freshness,
                              item.id,
                              event.target.value,
                            ),
                          )
                          clear()
                        }}
                      >
                        <option value="all">All scrape statuses</option>
                        <option value="never">Never attempted</option>
                        <option value="failed">Latest attempt failed</option>
                        <option value="unscraped">No successful scrape</option>
                        <option value="30">
                          No success or older than 30 days
                        </option>
                        <option value="90">
                          No success or older than 90 days
                        </option>
                        <option value="180">
                          No success or older than 180 days
                        </option>
                        <option value="365">
                          No success or older than 365 days
                        </option>
                      </select>
                    </div>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const values: BrowseValues = getBrowseValues(item)
              return (
                <tr
                  key={item.id}
                  data-selected={selected.includes(item.id) || undefined}
                >
                  <td className="table-selection-cell">
                    <input
                      type="checkbox"
                      aria-label={`Select ${item.title}`}
                      checked={selected.includes(item.id)}
                      disabled={queue.isPending}
                      onChange={(event) => {
                        changeSelection(
                          updateJobSelection(
                            selected,
                            ids,
                            item.id,
                            anchor,
                            'shiftKey' in event.nativeEvent &&
                              event.nativeEvent.shiftKey === true,
                            event.target.checked,
                          ),
                        )
                        setAnchor(item.id)
                      }}
                    />
                  </td>
                  {visible.map((field) => (
                    <td
                      key={field.key}
                      title={formatBrowseValue(field, values[field.key])}
                    >
                      {field.key === 'title' ? (
                        <Link href={`/${plural}/${item.id}`}>{item.title}</Link>
                      ) : (
                        formatBrowseValue(field, values[field.key])
                      )}
                    </td>
                  ))}
                  {providers.map((source) => {
                    const state = item.providerFreshness[source.id]
                    const date = state?.lastScrapedAt
                    const attempt = state?.lastAttempt
                    const successTitle = date
                      ? `Last successful scrape: ${date}`
                      : 'No successful scrape'
                    return (
                      <td key={`scraped-${source.id}`} title={successTitle}>
                        {attempt && attempt.status !== 'succeeded' ? (
                          <span className="flex w-full min-w-0 max-w-full items-center gap-1 overflow-hidden">
                            <Link
                              className="job-status shrink-0 underline underline-offset-2"
                              data-status={attempt.status}
                              href={scopedHref(
                                `/jobs?jobId=${encodeURIComponent(attempt.jobId)}`,
                                mediaType,
                              )}
                              title={`${source.displayName} attempt started: ${attempt.startedAt}${attempt.finishedAt ? `; finished: ${attempt.finishedAt}` : ''}. ${successTitle}`}
                            >
                              {attempt.status === 'failed'
                                ? 'Failed'
                                : attempt.status === 'running'
                                  ? 'Running'
                                  : 'Cancelled'}
                            </Link>
                            {attempt.status === 'failed' && attempt.error && (
                              <span
                                className="min-w-0 truncate"
                                title={attempt.error}
                              >
                                {attempt.error}
                              </span>
                            )}
                          </span>
                        ) : date ? (
                          <time
                            dateTime={date}
                            aria-label={`Last successful ${source.displayName} scrape: ${date}`}
                          >
                            {formatBrowseValue(
                              lastScrapedField,
                              Date.parse(date),
                            )}
                          </time>
                        ) : attempt ? (
                          'Succeeded'
                        ) : (
                          'Never'
                        )}
                        {state && !state.hasProviderIdentifier && (
                          <span
                            className="ml-2 text-amber-700"
                            title={`Needs ID for ${source.displayName}`}
                          >
                            Needs ID
                          </span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {!items.length && (
              <TableState
                colSpan={visible.length + providers.length + 1}
                error={films.isError}
              >
                {films.isPending
                  ? `Loading ${plural}...`
                  : films.isError
                    ? `${plural} unavailable.`
                    : `No matching ${plural}.`}
                {films.isError && (
                  <button
                    type="button"
                    className="ml-1 underline"
                    onClick={() => films.refetch()}
                  >
                    Retry
                  </button>
                )}
              </TableState>
            )}
          </tbody>
        </table>
        <div ref={sentinel} className="py-2 text-center">
          {films.isFetchNextPageError && (
            <p role="alert">Could not load more {plural}.</p>
          )}
          {films.isFetchingNextPage && (
            <p role="status" className="muted">
              Loading more {plural}...
            </p>
          )}
          {films.hasNextPage && !films.isFetchingNextPage && (
            <Button
              type="button"
              variant="ghost"
              disabled={films.isFetching || queue.isPending}
              onClick={() => films.fetchNextPage({ cancelRefetch: false })}
            >
              {films.isFetchNextPageError
                ? `Retry loading ${plural}`
                : `Load more ${plural}`}
            </Button>
          )}
          {!films.hasNextPage && items.length > 0 && (
            <p className="muted">
              All {items.length.toLocaleString()} matching {plural} loaded.
            </p>
          )}
        </div>
      </TableScroll>
      <FilmProviderSelection
        providers={providers}
        selected={launchProviders}
        disabled={queue.isPending}
        onChange={(next) => {
          setSelectedProviders(next)
          setConfirmed(false)
        }}
      />
      <div className="job-selection-toolbar">
        {selected.length > 0 && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={queue.isPending}
            onClick={clear}
          >
            Clear selection
          </Button>
        )}
        {!broadConfirmed && (
          <Button
            type="button"
            size="sm"
            disabled={
              queue.isPending || !selected.length || !launchProviders.length
            }
            onClick={() => {
              setConfirmed(true)
              setConfirmedKey(confirmationKey)
            }}
          >
            {selected.length > 0
              ? `Review ${operations} metadata jobs`
              : `Launch metadata jobs for 0 selected ${plural}`}
          </Button>
        )}
        {broadConfirmed && (
          <div
            className="job-action-review"
            role="region"
            aria-label="Review metadata jobs"
          >
            <p>
              <strong>Queue up to {operations} metadata jobs</strong> ·{' '}
              {selected.length} {plural} × {launchProviders.length}{' '}
              {launchProviders.length === 1 ? 'provider' : 'providers'}
            </p>
            <p>
              Only selected {plural} are queued. Missing IDs and active jobs are
              skipped; provider limits and cooldowns apply.
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={queue.isPending}
                onClick={() => queue.mutate()}
              >
                {queue.isPending
                  ? `Queueing ${progress}/${selected.length} ${plural}...`
                  : `Confirm ${operations} metadata jobs`}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={queue.isPending}
                onClick={() => setConfirmed(false)}
              >
                Back
              </Button>
            </div>
          </div>
        )}
      </div>
      <details className="muted text-xs">
        <summary>Scrape rules</summary>
        <p>
          Dates show successful scrapes, not imports. Failed, running and
          cancelled show the latest actual attempt. Never means no attempt or
          successful scrape; No successful scrape also includes failures. Only
          checked {plural} are queued, at provider limits. Missing IDs and
          active jobs are skipped. Freshness filters are rechecked before
          queueing; All scrape statuses allows rescraping.
        </p>
      </details>
      {queue.isError && (
        <p role="alert">
          Could not queue selection. Check progress before retrying.
        </p>
      )}
      {queue.data && (
        <div role="status">
          {queue.data.queued} jobs queued · {queue.data.skipped} skipped.{' '}
          <Link
            href={scopedHref(
              `/jobs?batchId=${encodeURIComponent(batchId)}`,
              mediaType,
            )}
          >
            View progress
          </Link>
          {queue.data.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}
    </div>
  )
}
