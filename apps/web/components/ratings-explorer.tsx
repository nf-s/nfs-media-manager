'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import {
  defaultRatingsRankingRequest,
  RatingsSettingsSchema,
  type RatingsRankingRequest,
  type RatingsRankingRow,
  type RatingsSettings,
  type RatingsSource,
} from '@repo/schemas/ratings-explorer'
import { Notice } from '@repo/ui/components/ds/feedback'
import {
  RatingDifference,
  RatingPositionStrip,
} from '@repo/ui/components/ds/ratings-explorer'
import { Segmented } from '@repo/ui/components/ds/segmented'
import { SortPicker } from '@repo/ui/components/ds/sort-picker'
import { FilterLine, PageHead } from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import {
  TableBody,
  TableHeader,
  TableState,
  TableCell,
  TableRow,
} from '@repo/ui/components/ui/table'
import { EMPTY_VALUE, formatItemCount } from '@repo/ui/lib/format'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { fetchRatingsRanking } from '@/utils/ratings-explorer-api'
import { useConfig } from './providers'
import {
  RatingsCalculation,
  displayedScore,
  nativeScore,
} from './ratings-explorer-calculation'
import { RatingsFilters } from './ratings-explorer-filters'
import { RatingsScoring, settingFor } from './ratings-explorer-scoring'
import {
  RatingsSources,
  type RatingSelection,
} from './ratings-explorer-sources'
import {
  SecondaryTableScroll,
  SecondaryTableToolbar,
  SecondaryTableSearch,
  SecondaryTableHead,
  SecondaryVirtualRows,
  useTableColumns,
  type TableColumn,
} from './secondary-table'

type Library = RatingsRankingRequest['library']
type Display = 'native' | 'adjusted'
type View = 'ranking' | 'sources'
const views: { value: View; label: string }[] = [
  { value: 'ranking', label: 'Ranking' },
  { value: 'sources', label: 'Sources' },
]
const modes: { value: Display; label: string }[] = [
  { value: 'native', label: 'Native' },
  { value: 'adjusted', label: 'Adjusted' },
]

function ratingColumns(
  sources: readonly RatingsSource[],
  display: Display,
): TableColumn[] {
  const groups = new Set(sources.map((source) => source.group))
  return [
    { key: 'title', label: 'Title', width: 195, required: true, fill: true },
    { key: 'score', label: 'Score / 100', width: 145 },
    ...sources.map((source) => ({
      key: source.key,
      label: source.label + ' / ' + (display === 'native' ? source.scale : 100),
      width: 155,
    })),
    { key: 'counted', label: 'Ratings counted', width: 120 },
    { key: 'year', label: 'Year', width: 78, defaultVisible: false },
    { key: 'spread', label: 'Spread', width: 95, defaultVisible: false },
    ...(groups.has('audience') && groups.has('critics')
      ? [
          {
            key: 'criticGap',
            label: 'Critic–audience gap',
            width: 155,
            defaultVisible: false,
          },
        ]
      : []),
    ...(groups.has('personal')
      ? [
          {
            key: 'personalGap',
            label: 'Personal–combined gap',
            width: 170,
            defaultVisible: false,
          },
        ]
      : []),
  ]
}

function RatingCell({
  column,
  row,
  source,
  sourceCount,
  display,
  onOpen,
}: {
  column: string
  row: RatingsRankingRow
  source: RatingsSource | undefined
  sourceCount: number
  display: Display
  onOpen: () => void
}) {
  if (column === 'title')
    return (
      <Button
        variant="link"
        className="ds-cell-title"
        title={row.title}
        onClick={onOpen}
      >
        {row.title}
      </Button>
    )
  if (column === 'score')
    return (
      <Button
        variant="ghost"
        size="xs"
        aria-label={'Combined score calculation for ' + row.title}
        onClick={onOpen}
      >
        {row.score === null ? 'Unscored' : displayedScore(row.score)}
        <RatingPositionStrip
          values={row.ratings.flatMap((r) =>
            r.status === 'counted' && r.adjusted !== null ? [r.adjusted] : [],
          )}
          score={row.score}
        />
      </Button>
    )
  if (column === 'counted') return row.counted + ' / ' + sourceCount
  if (column === 'year') return row.year ?? EMPTY_VALUE
  if (column === 'spread' || column === 'criticGap' || column === 'personalGap')
    return displayedScore(row[column])
  const rating = row.ratings.find((r) => r.key === source?.key)
  if (!source || !rating || rating.raw === null) return EMPTY_VALUE
  return (
    <RatingDifference
      value={
        display === 'native'
          ? nativeScore(rating.raw, source.scale)
          : displayedScore(rating.adjusted)
      }
      difference={
        rating.adjusted !== null && row.score !== null
          ? rating.adjusted - row.score
          : null
      }
      label={source.label + ' calculation for ' + row.title}
      onClick={onOpen}
    />
  )
}

export function RatingsExplorer({ library }: { library: Library }) {
  return <Explorer key={library} library={library} />
}

function Explorer({ library }: { library: Library }) {
  const [baseRequest, setRequest] = useState(() =>
    defaultRatingsRankingRequest(library),
  )
  const [search, setSearch] = useState('')
  const [display, setDisplay] = useState<Display>('native')
  const [view, setView] = useState<View>('ranking')
  const [readyView, setReadyView] = useState<View | null>(null)
  const [sources, setSources] = useState<RatingsSource[]>([])
  const [selections, setSelections] = useState<RatingSelection[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const { offset, limit, sort: sortKey, direction, ...filters } = baseRequest
  const sharedRequest = {
    ...filters,
    ranges: selections.map(({ range }) => range),
  }
  const request = { ...sharedRequest, offset, limit, sort: sortKey, direction }
  const storageKey = 'ratings-explorer:' + library + ':settings'
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey)
      const parsed = saved && RatingsSettingsSchema.safeParse(JSON.parse(saved))
      if (parsed && parsed.success)
        setRequest((previous) => ({ ...previous, settings: parsed.data }))
    } catch {
      /* The defaults also work without browser storage. */
    }
  }, [storageKey])
  // Subscribe after the view mounts, so React's development effect replay
  // cannot start, abort and repeat a feature read for the same interaction.
  useEffect(() => setReadyView(view), [view])
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setRequest((previous) =>
        previous.search === search.trim()
          ? previous
          : { ...previous, search: search.trim() },
      )
    }, 300)
    return () => window.clearTimeout(timer)
  }, [search])
  function scoring(settings: RatingsSettings) {
    setRequest((previous) => ({ ...previous, settings }))
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(settings))
    } catch {
      /* In-memory settings remain usable. */
    }
  }
  function sort(key: string) {
    setRequest((previous) => ({
      ...previous,
      sort: key,
      direction:
        previous.sort === key
          ? previous.direction === 'asc'
            ? 'desc'
            : 'asc'
          : key === 'title'
            ? 'asc'
            : 'desc',
    }))
  }
  const searchControl = (
    <SecondaryTableSearch
      label={
        library === 'film'
          ? 'Search titles or directors'
          : 'Search titles or artists'
      }
      maxLength={200}
      value={search}
      onChange={setSearch}
    />
  )
  const filterControl = (
    <RatingsFilters
      request={request}
      onResetRanges={() => {
        setSelections([])
        setEditing(null)
      }}
      onChange={(filters) =>
        setRequest((previous) => ({ ...previous, ...filters }))
      }
    />
  )
  const rangeControls = selections.length > 0 && (
    <FilterLine>
      {selections.map(({ range, label, interval }) => (
        <span key={range.dimension} className="ds-actions">
          <Button
            size="xs"
            aria-label={'Edit ' + label + ' range'}
            onClick={() => {
              setEditing(range.dimension)
              setView('sources')
            }}
          >
            {label} {interval}
          </Button>
          <Button
            icon
            size="xs"
            variant="ghost"
            aria-label={'Clear ' + label + ' range'}
            onClick={() => {
              setEditing(null)
              setSelections((previous) =>
                previous.filter(
                  ({ range: other }) => other.dimension !== range.dimension,
                ),
              )
            }}
          >
            <X className="ds-i" aria-hidden />
          </Button>
        </span>
      ))}
    </FilterLine>
  )
  return (
    <section className="sec-page ratings-page">
      <PageHead
        title="Ratings"
        actions={
          <Segmented
            label="Ratings view"
            value={view}
            options={views}
            onChange={(next) => {
              setEditing(null)
              setView(next)
            }}
          />
        }
      />
      <RatingsScoring
        sources={sources}
        settings={request.settings}
        onChange={scoring}
      />
      {view === 'ranking' ? (
        <Ranking
          request={request}
          ready={readyView === 'ranking'}
          sources={sources}
          onSources={setSources}
          sort={sort}
          display={display}
          setDisplay={setDisplay}
          search={searchControl}
          filters={filterControl}
          rangeControls={rangeControls}
          includeUnscored={() =>
            setRequest((previous) => ({ ...previous, scoredOnly: false }))
          }
        />
      ) : (
        <RatingsSources
          request={sharedRequest}
          ready={readyView === 'sources'}
          onSources={setSources}
          search={searchControl}
          filters={filterControl}
          rangeControls={rangeControls}
          editing={editing}
          onEdit={setEditing}
          onDrill={(selection) => {
            setSelections((previous) =>
              [
                ...previous.filter(
                  ({ range }) => range.dimension !== selection.range.dimension,
                ),
                selection,
              ].sort((a, b) =>
                a.range.dimension.localeCompare(b.range.dimension),
              ),
            )
            setEditing(null)
            setView('ranking')
          }}
        />
      )}
    </section>
  )
}

function Ranking({
  request,
  ready,
  sources: knownSources,
  onSources,
  sort,
  display,
  setDisplay,
  search,
  filters,
  rangeControls,
  includeUnscored,
}: {
  request: RatingsRankingRequest
  ready: boolean
  sources: RatingsSource[]
  onSources: (sources: RatingsSource[]) => void
  sort: (key: string) => void
  display: Display
  setDisplay: (display: Display) => void
  search: ReactNode
  filters: ReactNode
  rangeControls: ReactNode
  includeUnscored: () => void
}) {
  const { library } = request
  const { apiBaseUrl } = useConfig()
  const [calculation, setCalculation] = useState<{
    row: RatingsRankingRow
    sources: RatingsSource[]
    settings: RatingsSettings
  } | null>(null)
  const close = useCallback(() => setCalculation(null), [])
  const query = useVirtualTable({
    queryKey: [
      library === 'film' ? 'films' : 'albums',
      'ratings-explorer',
      request,
    ],
    pageSize: request.limit,
    enabled: ready,
    performanceScreen: library === 'film' ? 'film-ratings' : 'album-ratings',
    loadPage: async (page, size, signal) => {
      const requestedAt = performance.now()
      const result = await fetchRatingsRanking(
        apiBaseUrl,
        { ...request, offset: (page - 1) * size, limit: size },
        signal,
      )
      return {
        items: result.rows,
        totalCount: result.total,
        sources: result.sources,
        pageTiming: { requestedAt, readyAt: performance.now() },
      }
    },
  })
  // A changed ranking can be loading while the reader is still using a weight.
  const currentSources = query.firstPage?.sources
  useEffect(() => {
    if (currentSources) onSources(currentSources)
  }, [currentSources, onSources])
  const sources = currentSources ?? knownSources
  const weightedCount = sources.filter(
    (source) => settingFor(source, request.settings).weight > 0,
  ).length
  const allColumns = ratingColumns(sources, display)
  const columns = useTableColumns('ratings-' + library, allColumns)
  const shown = allColumns.filter((column) => columns.visible(column.key))
  const layout = columns.layout(shown.map((column) => column.key))
  const label = library === 'film' ? 'Film rankings' : 'Album rankings'
  return (
    <>
      <SecondaryTableToolbar
        search={search}
        filters={
          <>
            <SortPicker
              value={request.sort}
              options={allColumns}
              onChange={sort}
            />
            <Button
              icon
              onClick={() => sort(request.sort)}
              aria-label={
                'Sort direction: ' +
                (request.direction === 'asc' ? 'ascending' : 'descending')
              }
            >
              {request.direction === 'asc' ? (
                <ArrowUp className="ds-i" aria-hidden />
              ) : (
                <ArrowDown className="ds-i" aria-hidden />
              )}
            </Button>
            <Segmented
              label="Source rating values"
              options={modes}
              value={display}
              onChange={setDisplay}
            />
            {filters}
          </>
        }
        count={
          query.hasTotal
            ? formatItemCount(query.total, {
                one: library,
                other: library + 's',
              })
            : query.isError
              ? undefined
              : 'Loading ratings…'
        }
        columns={columns.controls}
      />
      {rangeControls}
      <p className="ds-muted ratings-key">
        Parentheses show adjusted points above or below the combined score. The
        strip marks counted ratings and the combined score.
      </p>
      {query.isError && (
        <Notice
          tone="danger"
          action={
            <Button size="xs" onClick={query.retry}>
              Retry
            </Button>
          }
        >
          Could not load rankings.
        </Notice>
      )}
      <SecondaryTableScroll
        ref={query.scroller}
        onScroll={query.onScroll}
        role="region"
        aria-label={label}
        aria-busy={query.isFetching}
      >
        <table
          className="ds-table"
          {...layout.table}
          aria-label={label}
          aria-rowcount={query.hasTotal ? query.total + 1 : undefined}
        >
          {layout.colgroup}
          <TableHeader>
            <TableRow>
              {shown.map((column) => (
                <SecondaryTableHead
                  key={column.key}
                  label={column.label}
                  sortKey={column.key}
                  sortBy={request.sort}
                  direction={request.direction}
                  onSort={sort}
                  resizer={columns.resizer(column.key)}
                  align={column.key === 'title' ? undefined : 'end'}
                  sticky={column.key === 'title' ? 0 : undefined}
                  stickyEdge={column.key === 'title'}
                />
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.hasTotal && query.total === 0 && (
              <TableState colSpan={shown.length}>
                No matching {library === 'film' ? 'films' : 'albums'}.{' '}
                {request.scoredOnly && (
                  <Button variant="link" size="xs" onClick={includeUnscored}>
                    Include unscored items
                  </Button>
                )}
              </TableState>
            )}
            <SecondaryVirtualRows
              window={query}
              colSpan={shown.length}
              renderRow={(item, index) => (
                <TableRow
                  key={item.id}
                  aria-rowindex={index + 2}
                  selected={calculation?.row.id === item.id}
                  style={{ height: query.rowHeight }}
                >
                  {shown.map((column) => (
                    <TableCell
                      key={column.key}
                      sticky={column.key === 'title' ? 0 : undefined}
                      stickyEdge={column.key === 'title'}
                      align={column.key === 'title' ? undefined : 'end'}
                    >
                      <RatingCell
                        row={item}
                        column={column.key}
                        source={sources.find(
                          (source) => source.key === column.key,
                        )}
                        sourceCount={weightedCount}
                        display={display}
                        onOpen={() =>
                          setCalculation({
                            row: item,
                            sources,
                            settings: request.settings,
                          })
                        }
                      />
                    </TableCell>
                  ))}
                </TableRow>
              )}
            />
          </TableBody>
        </table>
      </SecondaryTableScroll>
      {calculation && (
        <RatingsCalculation
          {...calculation}
          library={library}
          onClose={close}
        />
      )}
    </>
  )
}
