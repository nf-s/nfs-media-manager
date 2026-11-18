'use client'

import { DetailLink } from './detail-link'
import Link from 'next/link'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import {
  type BrowseField,
  type BrowseValues,
  filmBrowseFields,
  albumBrowseFields,
  formatBrowseValue,
  getBrowseValues,
} from '@repo/schemas/browse'
import {
  ProviderFreshnessFilterSchema,
  QueueFilmSelectionSchema,
  type ProviderFreshnessFilter,
} from '@repo/schemas/film-selection'
import type { ListeningPeriod } from '@repo/schemas/listening'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import type { ProviderSummary } from '@repo/schemas/provider'
import { Notice, State } from '@repo/ui/components/ds/feedback'
import { Pill } from '@repo/ui/components/ds/pill'
import {
  Status,
  statusLabels,
  type StatusState,
} from '@repo/ui/components/ds/status'
import { Button } from '@repo/ui/components/ui/button'
import {
  TableCell,
  TableHead,
  TableRow,
  TableSelectionBar,
  TableState,
} from '@repo/ui/components/ui/table'
import { formatAge, formatCount, formatDateTime } from '@repo/ui/lib/format'
import { useConfig } from './providers'
import {
  SecondaryColumnFilter,
  SecondaryHeaderFilter,
  SecondaryTableScroll,
  SecondaryTableHead,
  SecondaryVirtualRows,
  useTableColumns,
} from './secondary-table'
import { FilmProviderSelection } from './film-provider-selection'
import AiSearch from './ai-search'
import { RangeEditor } from './browse-controls'
import { useDetailInspector } from './detail-inspector-context'
import { ListeningControls } from './listening-controls'
import MetadataSelectionToolbar, {
  type MetadataSelectionFilters,
} from './metadata-selection-toolbar'
import { useFilmSelection } from '@/hooks/useFilmSelection'
import { mediaAiSearchTarget } from '@/utils/ai-search'
import { updateJobSelection } from '@/utils/job-selection'
import { dispatchFilmSelection } from '@/utils/film-selection'
import { fetchApiData } from '@/utils/api'
import { listeningScrobblesField } from '@/utils/listening-filters'
import type { MediaScope } from '@/utils/media-scope'

type Props = {
  providers: ProviderSummary[]
  mediaType?: MediaScope
  /** Controls placed after the search, such as the library. */
  filters?: ReactNode
}

/** Width of the selection column, which the title is pinned after. */
const selectionWidth = 28
/** A successful scrape older than this reads as stale. */
const staleAfterDays = 180

/**
 * One provider's freshness for one item: what is running or failed, else the
 * age of the last successful scrape. Stale and missing values use the status
 * colours so the gaps stand out.
 */
export function FreshnessState({
  label,
  lastSuccess,
  attempt,
  jobId,
  error,
  attempted = false,
  needsId = false,
  now = new Date(),
}: {
  label: string
  lastSuccess: string | null | undefined
  attempt?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | null
  jobId?: string
  error?: string | null
  /** Tried without a successful scrape and without a known job status. */
  attempted?: boolean
  needsId?: boolean
  now?: Date
}) {
  const successTitle = lastSuccess
    ? `Last successful ${label} scrape: ${formatDateTime(lastSuccess)}`
    : `No successful ${label} scrape`
  const active =
    attempt && attempt !== 'succeeded'
      ? { state: attempt, text: statusLabels[attempt] }
      : null
  const stale =
    lastSuccess !== null &&
    lastSuccess !== undefined &&
    now.getTime() - Date.parse(lastSuccess) > staleAfterDays * 86_400_000
  const status: { state: StatusState; text: ReactNode } | null = active
    ? active
    : lastSuccess
      ? stale
        ? {
            state: 'attention',
            text: (
              <time dateTime={lastSuccess}>{formatAge(lastSuccess, now)}</time>
            ),
          }
        : null
      : attempt === 'succeeded'
        ? { state: 'done', text: 'Done' }
        : { state: 'never', text: attempted ? 'Not scraped' : 'Never' }
  const title = [successTitle, active && error ? error : '']
    .filter(Boolean)
    .join('. ')
  return (
    <span className="ds-cell-id" title={title}>
      {status ? (
        active && jobId ? (
          <DetailLink kind="job" id={jobId}>
            <Status state={status.state}>{status.text}</Status>
          </DetailLink>
        ) : (
          <Status state={status.state}>{status.text}</Status>
        )
      ) : (
        lastSuccess && (
          <time dateTime={lastSuccess} className="ds-muted">
            {formatAge(lastSuccess, now)}
          </time>
        )
      )}
      {active && lastSuccess && (
        <time dateTime={lastSuccess} className="ds-cell-sub">
          {formatAge(lastSuccess, now)}
        </time>
      )}
      {active?.state === 'failed' && error && (
        <span className="ds-cell-sub ops-danger" title={error}>
          {error}
        </span>
      )}
      {needsId && (
        <Pill tone="attention" title={`Needs ID for ${label}`}>
          Needs ID
        </Pill>
      )}
    </span>
  )
}

const emptyFilters: MetadataSelectionFilters = {
  q: '',
  filters: [],
  ranges: [],
}
const olderFreshnessLabel = (days: number) =>
  `No success or older than ${days} days`
export const providerFreshnessOptions = [
  { value: 'never', label: 'Never attempted' },
  { value: 'failed', label: 'Latest attempt failed' },
  { value: 'unscraped', label: 'No successful scrape' },
  ...[30, 90, 180, 365].map((days) => ({
    value: String(days),
    label: olderFreshnessLabel(days),
  })),
]

export function providerFreshnessValue(filter: ProviderFreshnessFilter) {
  return filter.mode === 'older' ? String(filter.olderThanDays) : filter.mode
}

export function providerFreshnessLabel(filter: ProviderFreshnessFilter) {
  if (filter.mode === 'older') return olderFreshnessLabel(filter.olderThanDays)
  return (
    providerFreshnessOptions.find(({ value }) => value === filter.mode)
      ?.label ?? 'All values'
  )
}

export function updateProviderFreshness(
  filters: ProviderFreshnessFilter[],
  provider: string,
  value: string | readonly string[],
): ProviderFreshnessFilter[] {
  const remaining = filters.filter((filter) => filter.provider !== provider)
  const values = typeof value === 'string' ? [value] : value
  const next = values
    .filter((mode) => mode !== 'all')
    .map((mode) =>
      ProviderFreshnessFilterSchema.parse(
        mode === 'never' || mode === 'failed' || mode === 'unscraped'
          ? { provider, mode }
          : { provider, mode: 'older', olderThanDays: Number(mode) },
      ),
    )
  return [...remaining, ...next]
}

export default function FilmSelectionTable(props: Props) {
  if (!props.providers.length)
    return (
      <State
        size="sm"
        title="No metadata providers are available for this library."
      />
    )
  return <SelectionTable key={props.mediaType} {...props} />
}

function SelectionTable({
  providers,
  mediaType = 'film',
  filters: pageFilters,
}: Props) {
  const plural = mediaType === 'album' ? 'albums' : 'films'
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const inspector = useDetailInspector()
  const [provider, setProvider] = useState('')
  const [freshness, setFreshness] = useState<ProviderFreshnessFilter[]>([])
  const [legacyImports, setLegacyImports] = useState<string[]>([])
  const legacyImport =
    legacyImports.length === 1 ? (legacyImports[0] ?? 'all') : 'all'
  const [selectedProviders, setSelectedProviders] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [browseFilters, setBrowseFilters] = useState(emptyFilters)
  const { q, filters, ranges, listening, limitResults } = browseFilters
  const [listeningSort, setListeningSort] = useState<ListeningPeriod>()
  const [sortBy, setSortBy] = useState('dateAdded')
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc')
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
    legacyImport,
  })
  if (sortBy === 'lastScrapedAt') params.set('provider', provider)
  if (limitResults !== undefined)
    params.set('limitResults', String(limitResults))
  if (listening) params.set('listening', JSON.stringify(listening))
  if (listeningSort) params.set('listeningSort', JSON.stringify(listeningSort))
  const queryIdentity = params.toString()
  // The histogram counts the library under the browse filters alone.
  const listeningParams = new URLSearchParams({
    q,
    filters: JSON.stringify(filters),
    ranges: JSON.stringify(ranges),
  })
  const queueKey = ['metadata-selection-queue', mediaType]
  const queuePending = useIsMutating({ mutationKey: queueKey }) > 0
  const { fields, facets, films, titleItems, titlesLoading, titlesError } =
    useFilmSelection(queryIdentity, mediaType, draft, queuePending)
  const baseFields =
    fields.data ??
    (mediaType === 'album' ? albumBrowseFields : filmBrowseFields)
  const available: BrowseField[] =
    mediaType === 'album'
      ? [...baseFields, listeningScrobblesField(listeningSort)]
      : baseFields
  const columns = useTableColumns(`${mediaType}-metadata-selection`, [
    ...available.map((field) => ({
      key: field.key,
      label: field.label,
      defaultVisible: [
        'title',
        'dateAdded',
        ...(mediaType === 'album' ? ['artist'] : []),
      ].includes(field.key),
      required: field.key === 'title',
    })),
    { key: 'legacyImport', label: 'Legacy import' },
    ...providers.map((item) => ({
      key: `provider-${item.id}`,
      label: `${item.displayName} · Last scraped`,
    })),
  ])
  const visible = available.filter((field) => columns.visible(field.key))
  const visibleProviders = providers.filter((item) =>
    columns.visible(`provider-${item.id}`),
  )
  const columnWidths = visible.map((field) =>
    field.key === 'title' ? 160 : field.type === 'text' ? 120 : 88,
  )
  const tableWidth =
    selectionWidth +
    columnWidths.reduce((total, width) => total + width, 0) +
    (columns.visible('legacyImport') ? 110 : 0) +
    visibleProviders.length * 110
  const ids = [...new Set(films.loadedSlots.map(({ item }) => item.id))]
  const allChecked = ids.length > 0 && ids.every((id) => selected.includes(id))
  const partiallyChecked =
    !allChecked && ids.some((id) => selected.includes(id))
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
    mutationKey: queueKey,
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
  useEffect(() => {
    if (all.current) all.current.indeterminate = partiallyChecked
  }, [partiallyChecked])
  function clear() {
    setSelected([])
    setAnchor(null)
    setConfirmed(false)
  }
  function changeSelection(next: string[]) {
    setSelected(next)
    setConfirmed(false)
  }
  function changeFilters(next: MetadataSelectionFilters) {
    if (queue.isPending) return
    setBrowseFilters(next)
    clear()
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
  const now = new Date()
  const noun = mediaType === 'album' ? 'Album' : 'Film'
  return (
    <div className="ops-fill">
      <MetadataSelectionToolbar
        disabled={queue.isPending}
        fields={available}
        value={browseFilters}
        providerFilters={freshness.map((item) => {
          const value = providerFreshnessValue(item)
          const source = providers.find(({ id }) => id === item.provider)
          const label = providerFreshnessLabel(item)
          return {
            key: `${item.provider}:${value}`,
            label: `${source?.displayName ?? item.provider} · ${label}`,
            remove: () => {
              setFreshness(freshness.filter((filter) => filter !== item))
              clear()
            },
          }
        })}
        otherFiltersActive={legacyImport !== 'all'}
        onChange={changeFilters}
        onClear={() => {
          setDraft('')
          setFreshness([])
          setLegacyImports([])
          changeFilters(emptyFilters)
        }}
        search={
          <AiSearch
            target={mediaAiSearchTarget(mediaType, available)}
            queryIdentity={queryIdentity}
            autocomplete={{
              options: (facets.data ?? []).filter(
                (option) =>
                  !filters.some(
                    (filter) =>
                      filter.field === option.field &&
                      filter.value === option.value,
                  ),
              ),
              items: titleItems,
              titlesLoading,
              titlesError,
              placeholder: `Search ${plural} or add a filter`,
              value: draft,
              disabled: queue.isPending,
              onFocus: facets.activate,
              onValueChange: setDraft,
              onAddFilter: (filter) => {
                changeFilters({
                  ...browseFilters,
                  filters: [
                    ...filters.filter(
                      (f) =>
                        f.field !== filter.field || f.value !== filter.value,
                    ),
                    filter,
                  ],
                })
                setDraft('')
              },
              onApplyText: (value) => {
                changeFilters({ ...browseFilters, q: value })
                setDraft('')
              },
              onOpenItem: (id, trigger) => {
                if (inspector) inspector.open({ kind: mediaType, id }, trigger)
                else
                  window.location.assign(`/${plural}/${encodeURIComponent(id)}`)
              },
            }}
            onApply={(plan) => {
              if (queue.isPending) return
              changeFilters({
                q: plan.q,
                filters: plan.filters,
                ranges: plan.ranges,
                listening: plan.listening ?? undefined,
                limitResults: plan.limitResults ?? undefined,
              })
              setProvider('')
              setSortBy(plan.sortBy)
              setDirection(plan.direction)
              setListeningSort(plan.listeningSort ?? undefined)
              setDraft('')
            }}
          />
        }
        filters={pageFilters}
        count={`${films.firstPage ? formatCount(films.firstPage.totalCount) : '…'} ${plural}`}
        columns={columns.controls}
      >
        {mediaType === 'album' && (
          <ListeningControls
            apiBaseUrl={apiBaseUrl}
            library="album"
            params={listeningParams}
            filter={listening}
            sortPeriod={listeningSort}
            total={films.firstPage?.totalCount}
            examples={films.loadedSlots.slice(0, 3).map(({ item }) => ({
              id: item.id,
              title: item.title,
              artworkUrl: item.artworkUrl,
            }))}
            onFilterChange={(listening) =>
              changeFilters({ ...browseFilters, listening })
            }
            onSortPeriodChange={(period) => {
              if (queue.isPending) return
              setListeningSort(period)
              if (sortBy === 'listeningScrobbles') clear()
            }}
          />
        )}
      </MetadataSelectionToolbar>
      {(freshness.length > 0 ||
        (films.isError && films.total > 0) ||
        facets.isError) && (
        <div className="ops-notice">
          {freshness.length > 0 && (
            <p className="ds-help">
              Match any selected status per provider, and every filtered
              provider.
            </p>
          )}
          {films.isError && films.total > 0 && (
            <Notice
              tone="danger"
              action={
                <Button size="xs" onClick={films.retry}>
                  Retry
                </Button>
              }
            >
              Could not load {plural}.
            </Notice>
          )}
          {facets.isError && (
            <Notice
              tone="danger"
              action={
                <Button size="xs" onClick={() => facets.refetch()}>
                  Retry
                </Button>
              }
            >
              Filter suggestions unavailable.
            </Notice>
          )}
        </div>
      )}
      <SecondaryTableScroll
        ref={films.scroller}
        onScroll={films.onScroll}
        aria-label={`${noun} selection`}
        role="region"
        aria-busy={films.isFetching}
      >
        <table
          className="ds-table"
          data-layout="fixed"
          style={{ minWidth: tableWidth }}
          aria-label={`${noun}s to scrape`}
        >
          <colgroup>
            <col style={{ width: selectionWidth }} />
            {visible.map((field, index) => (
              <col key={field.key} style={{ width: columnWidths[index] }} />
            ))}
            {columns.visible('legacyImport') && <col style={{ width: 110 }} />}
            {visibleProviders.map((item) => (
              <col key={`scraped-${item.id}`} style={{ width: 110 }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <TableHead sticky={0}>
                <input
                  ref={all}
                  type="checkbox"
                  className="ds-check"
                  aria-label={`Select all loaded ${plural}`}
                  checked={allChecked}
                  disabled={queue.isPending || !ids.length}
                  onChange={(event) => {
                    changeSelection(
                      event.target.checked
                        ? [...new Set([...selected, ...ids])]
                        : [],
                    )
                    setAnchor(null)
                  }}
                />
              </TableHead>
              {visible.map((field) => (
                <SecondaryTableHead
                  key={field.key}
                  sortKey={field.key}
                  label={field.label}
                  sortBy={sortBy}
                  direction={direction}
                  onSort={sort}
                  disabled={queue.isPending}
                  align={field.type === 'number' ? 'end' : undefined}
                  sticky={field.key === 'title' ? selectionWidth : undefined}
                  stickyEdge={field.key === 'title'}
                  filter={
                    field.filterable && field.type !== 'text' ? (
                      <SecondaryHeaderFilter
                        label={`${field.label} range`}
                        disabled={queue.isPending}
                        active={ranges.some(
                          (range) => range.field === field.key,
                        )}
                      >
                        <RangeEditor
                          presentation="panel"
                          fields={[field]}
                          ranges={ranges.filter(
                            (range) => range.field === field.key,
                          )}
                          onChange={(next) => {
                            changeFilters({
                              ...browseFilters,
                              ranges: [
                                ...ranges.filter(
                                  (range) => range.field !== field.key,
                                ),
                                ...next,
                              ],
                            })
                          }}
                        />
                        {ranges.some((range) => range.field === field.key) && (
                          <Button
                            size="md"
                            type="button"
                            variant="ghost"
                            onClick={() => {
                              changeFilters({
                                ...browseFilters,
                                ranges: ranges.filter(
                                  (range) => range.field !== field.key,
                                ),
                              })
                            }}
                          >
                            Clear range
                          </Button>
                        )}
                      </SecondaryHeaderFilter>
                    ) : undefined
                  }
                />
              ))}
              {columns.visible('legacyImport') && (
                <SecondaryTableHead
                  sortKey="legacyImport"
                  label="Legacy import"
                  filter={
                    <SecondaryColumnFilter
                      label="Legacy import"
                      options={[
                        { value: 'yes', label: 'Yes' },
                        { value: 'no', label: 'No' },
                      ]}
                      value={legacyImports}
                      disabled={queue.isPending}
                      onChange={(next) => {
                        setLegacyImports(next)
                        clear()
                      }}
                    />
                  }
                  sortBy={sortBy}
                  direction={direction}
                  onSort={sort}
                  disabled={queue.isPending}
                />
              )}
              {visibleProviders.map((item) => (
                <SecondaryTableHead
                  key={item.id}
                  sortKey={`provider-${item.id}`}
                  label={`${item.displayName} · Last scraped`}
                  filter={
                    <SecondaryColumnFilter
                      label={`${item.displayName} freshness`}
                      disabled={queue.isPending}
                      options={providerFreshnessOptions}
                      value={freshness
                        .filter((filter) => filter.provider === item.id)
                        .map(providerFreshnessValue)}
                      onChange={(next) => {
                        setFreshness(
                          updateProviderFreshness(freshness, item.id, next),
                        )
                        clear()
                      }}
                    />
                  }
                  sortBy={
                    sortBy === 'lastScrapedAt' ? `provider-${provider}` : sortBy
                  }
                  direction={direction}
                  onSort={() => sort('lastScrapedAt', item.id)}
                  disabled={queue.isPending}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {(!films.isError || films.hasTotal) && (
              <SecondaryVirtualRows
                window={films}
                colSpan={columns.count + 1}
                renderRow={(item) => {
                  const values: BrowseValues = getBrowseValues(item)
                  return (
                    <TableRow
                      key={item.id}
                      selected={selected.includes(item.id)}
                    >
                      <TableCell sticky={0}>
                        <input
                          type="checkbox"
                          className="ds-check"
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
                      </TableCell>
                      {visible.map((field) => (
                        <TableCell
                          key={field.key}
                          title={formatBrowseValue(field, values[field.key])}
                          align={field.type === 'number' ? 'end' : undefined}
                          sticky={
                            field.key === 'title' ? selectionWidth : undefined
                          }
                          stickyEdge={field.key === 'title'}
                        >
                          {field.key === 'title' ? (
                            <DetailLink
                              kind={mediaType}
                              id={item.id}
                              className="ds-cell-title"
                            >
                              {item.title}
                            </DetailLink>
                          ) : (
                            formatBrowseValue(field, values[field.key])
                          )}
                        </TableCell>
                      ))}
                      {columns.visible('legacyImport') && (
                        <TableCell>
                          {item.hasLegacyImport ? 'Yes' : 'No'}
                        </TableCell>
                      )}
                      {visibleProviders.map((source) => {
                        const state = item.providerFreshness[source.id]
                        const attempt = state?.lastAttempt
                        return (
                          <TableCell key={`scraped-${source.id}`}>
                            <FreshnessState
                              label={source.displayName}
                              lastSuccess={state?.lastScrapedAt}
                              attempt={attempt?.status}
                              jobId={attempt?.jobId}
                              error={attempt?.error}
                              needsId={Boolean(
                                state && !state.hasProviderIdentifier,
                              )}
                              now={now}
                            />
                          </TableCell>
                        )
                      })}
                    </TableRow>
                  )
                }}
              />
            )}
            {!films.total && (
              <TableState colSpan={columns.count + 1} error={films.isError}>
                {films.isPending
                  ? `Loading ${plural}...`
                  : films.isError
                    ? `${noun}s unavailable.`
                    : `No matching ${plural}.`}
                {films.isError && (
                  <Button variant="link" size="xs" onClick={films.retry}>
                    Retry
                  </Button>
                )}
              </TableState>
            )}
          </tbody>
        </table>
      </SecondaryTableScroll>
      {(selected.length > 0 || queue.isPending) && (
        <TableSelectionBar className="ops-selectbar">
          <span role="status">
            <b>{formatCount(selected.length)} selected</b>
          </span>
          <FilmProviderSelection
            providers={providers}
            selected={launchProviders}
            disabled={queue.isPending}
            onChange={(next) => {
              setSelectedProviders(next)
              setConfirmed(false)
            }}
          />
          <span className="ds-actions ds-toolbar-end">
            {!broadConfirmed ? (
              <Button
                variant="primary"
                type="button"
                disabled={
                  queue.isPending || !selected.length || !launchProviders.length
                }
                onClick={() => {
                  setConfirmed(true)
                  setConfirmedKey(confirmationKey)
                }}
              >
                Review {formatCount(operations)} metadata jobs
              </Button>
            ) : (
              <span
                className="ops-review"
                role="region"
                aria-label="Review metadata jobs"
              >
                <span>
                  <b>Queue up to {formatCount(operations)} metadata jobs</b> ·{' '}
                  {formatCount(selected.length)} {plural} ×{' '}
                  {launchProviders.length}{' '}
                  {launchProviders.length === 1 ? 'provider' : 'providers'}.
                  Only selected {plural} are queued. Missing IDs and active jobs
                  are skipped; provider limits and cooldowns apply.
                </span>
                <span className="ds-actions">
                  <Button
                    variant="primary"
                    type="button"
                    disabled={queue.isPending}
                    onClick={() => queue.mutate()}
                  >
                    {queue.isPending
                      ? `Queueing ${progress}/${selected.length} ${plural}...`
                      : `Confirm ${formatCount(operations)} metadata jobs`}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={queue.isPending}
                    onClick={() => setConfirmed(false)}
                  >
                    Back
                  </Button>
                </span>
              </span>
            )}
          </span>
          <details className="ops-rules">
            <summary>Scrape rules</summary>
            <p>
              Dates show successful scrapes, not imports. Failed, running and
              cancelled show the latest actual attempt. Never means no attempt
              or successful scrape; No successful scrape also includes failures.
              Only checked {plural} are queued, at provider limits. Missing IDs
              and active jobs are skipped. Freshness filters are rechecked
              before queueing; no freshness filter allows rescraping.
            </p>
          </details>
        </TableSelectionBar>
      )}
      {(queue.isError || queue.data) && (
        <div className="ops-notice">
          {queue.isError && (
            <Notice tone="danger">
              Could not queue selection. Check progress before retrying.
            </Notice>
          )}
          {queue.data && (
            <Notice
              action={
                <Button asChild size="xs">
                  <Link href={`/jobs?batchId=${encodeURIComponent(batchId)}`}>
                    View progress
                  </Link>
                </Button>
              }
            >
              {formatCount(queue.data.queued)} jobs queued ·{' '}
              {formatCount(queue.data.skipped)} skipped.
              {queue.data.warnings.map((warning) => (
                <span className="block" key={warning}>
                  {warning}
                </span>
              ))}
            </Notice>
          )}
        </div>
      )}
    </div>
  )
}
