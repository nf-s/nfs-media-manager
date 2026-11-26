'use client'

import { useEffect, useState } from 'react'
import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, ListFilter, SlidersHorizontal } from 'lucide-react'
import { normalizeTagName } from '@repo/schemas/tags'
import {
  defaultRatingsRankingRequest,
  RatingsSettingsSchema,
  type RatingsRankingRequest,
  type RatingsSettings,
  type RatingsSource,
} from '@repo/schemas/ratings-explorer'
import {
  FilterLine,
  PageHead,
  Toolbar,
  ToolbarCount,
} from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import { formatCount } from '@repo/ui/lib/format'
import { rankingKey, ratingSourcesKey } from '@/utils/ratings-explorer-api'
import { ratingChartsKey } from '@/utils/ratings-explorer-charts-api'
import {
  ResultButton,
  ResultSection,
  ResultSegmented,
  ResultSortPicker,
  ResultToolbarToggle,
} from './result-feedback'
import { BrowseFilterPill } from './browse-controls'
import { SecondaryTableSearch } from './secondary-table'
import { RatingsScoring } from './ratings-explorer-scoring'
import {
  ratingTagLabel,
  RatingsFilters,
  type RatingFilters,
} from './ratings-explorer-filters'
import {
  RatingsSources,
  type RatingSelection,
} from './ratings-explorer-sources'
import { RatingsCharts } from './ratings-explorer-charts'
import { Ranking, ratingSortOptions } from './ratings-explorer-ranking'

type Library = RatingsRankingRequest['library']
type View = 'ranking' | 'sources' | 'agreement' | 'compare'
const views: { value: View; label: string }[] = [
  { value: 'ranking', label: 'Ranking' },
  { value: 'sources', label: 'Sources' },
  { value: 'agreement', label: 'Agreement' },
  { value: 'compare', label: 'Compare' },
]
export function RatingsExplorer({ library }: { library: Library }) {
  return <Explorer key={library} library={library} />
}

/** Reserve the last count's space while the active view loads its next cohort. */
function RatingsCount({ text, failed }: { text?: string; failed: boolean }) {
  const [previous, setPrevious] = useState(text)
  useEffect(() => {
    if (text !== undefined) setPrevious(text)
  }, [text])
  if (text === undefined && previous === undefined)
    return failed ? null : 'Loading ratings…'
  return (
    <span className={text === undefined ? 'invisible' : undefined}>
      {text ?? previous}
    </span>
  )
}
function Explorer({ library }: { library: Library }) {
  const [base, setRequest] = useState(() =>
    defaultRatingsRankingRequest(library),
  )
  const [view, setView] = useState<View>('ranking')
  const [readyView, setReadyView] = useState<View | null>(null)
  const [search, setSearch] = useState('')
  const [scoringOpen, setScoringOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [filterVersion, resetFilterInputs] = useState(0)
  const [sources, setSources] = useState<RatingsSource[]>([])
  const [display, setDisplay] = useState<'native' | 'adjusted'>('native')
  const [selections, setSelections] = useState<RatingSelection[]>([])
  const [counts, setCounts] = useState({
    total: 0,
    unscored: 0,
    libraryTotal: 0,
  })
  const [axes, setAxes] = useState<{ x?: string; y?: string }>({})
  const {
    offset,
    limit,
    sort: sortKey,
    direction,
    scoredOnly,
    ...filters
  } = base
  const shared = {
    ...filters,
    scoredOnly: false,
    ranges: selections.map((s) => s.range),
  }
  const request = {
    ...shared,
    offset,
    limit,
    sort: sortKey,
    direction,
    scoredOnly,
    ...(display === 'adjusted' && sources.some((s) => s.key === sortKey)
      ? { adjustedSort: true }
      : {}),
  }
  const client = useQueryClient()
  const activeKey =
    view === 'ranking'
      ? rankingKey(request)
      : view === 'sources'
        ? ratingSourcesKey(shared)
        : ratingChartsKey(view, shared, axes)
  const fetching = useIsFetching({ queryKey: activeKey })
  const first = client.getQueryState<{ total: number; libraryTotal: number }>(
    view === 'ranking' ? [...activeKey, 1] : activeKey,
  )
  const libraryTotal =
    view === 'ranking'
      ? counts.libraryTotal
      : (first?.data?.libraryTotal ?? counts.libraryTotal)
  const shown = view === 'ranking' ? counts.total : first?.data?.total
  const storageKey = 'ratings-explorer:' + library + ':settings'
  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey)
      const parsed = saved && RatingsSettingsSchema.safeParse(JSON.parse(saved))
      if (parsed && parsed.success)
        setRequest((p) => ({ ...p, settings: parsed.data }))
    } catch {
      /* Browser storage is optional. */
    }
  }, [storageKey])
  useEffect(() => setReadyView(view), [view])
  useEffect(() => {
    const timer = setTimeout(
      () =>
        setRequest((p) =>
          p.search === search.trim() ? p : { ...p, search: search.trim() },
        ),
      300,
    )
    return () => clearTimeout(timer)
  }, [search])
  function scoring(settings: RatingsSettings) {
    setRequest((p) => ({ ...p, settings }))
    try {
      localStorage.setItem(storageKey, JSON.stringify(settings))
    } catch {
      /* In-memory controls remain usable. */
    }
  }
  function sort(key: string) {
    setRequest((p) => ({
      ...p,
      sort: key,
      direction:
        p.sort === key
          ? p.direction === 'asc'
            ? 'desc'
            : 'asc'
          : key === 'title' || key === 'year'
            ? 'asc'
            : 'desc',
    }))
  }
  function selectRange(dimension: string, selection?: RatingSelection) {
    setSelections((prev) =>
      [
        ...prev.filter((s) => s.range.dimension !== dimension),
        ...(selection ? [selection] : []),
      ].sort((a, b) => a.range.dimension.localeCompare(b.range.dimension)),
    )
  }
  function updateFilters(next: Partial<RatingFilters>, external = false) {
    setRequest((p) => ({ ...p, ...next }))
    if (external) resetFilterInputs((n) => n + 1)
  }
  const chips = [
    ...(base.tag
      ? [
          {
            label: ratingTagLabel(base),
            clear: () => updateFilters({ tag: '', tagField: undefined }, true),
          },
        ]
      : []),
    ...(base.yearFrom || base.yearTo
      ? [
          {
            label:
              'Year ' + (base.yearFrom ?? '…') + '–' + (base.yearTo ?? '…'),
            clear: () =>
              updateFilters({ yearFrom: undefined, yearTo: undefined }, true),
          },
        ]
      : []),
    ...(base.watched !== undefined
      ? [
          {
            label: base.watched ? 'Watched' : 'Not watched',
            clear: () => updateFilters({ watched: undefined }, true),
          },
        ]
      : []),
    ...(base.minPlays !== undefined
      ? [
          {
            label: 'Plays ≥ ' + base.minPlays,
            clear: () => updateFilters({ minPlays: undefined }, true),
          },
        ]
      : []),
    ...selections.map((s) => ({
      label: s.label + ' ' + s.interval,
      clear: () => selectRange(s.range.dimension),
    })),
  ]
  return (
    <ResultSection
      className="sec-page ratings-page"
      identity={JSON.stringify(activeKey)}
      result={{
        isFetching:
          readyView !== view ||
          fetching > 0 ||
          !first ||
          first.status === 'pending',
        isError: first?.status === 'error',
      }}
    >
      <PageHead
        title="Ratings"
        note={
          sources.length || first?.data
            ? formatCount(libraryTotal) +
              ' ' +
              library +
              's · ' +
              formatCount(sources.length) +
              ' sources'
            : undefined
        }
      />
      <div className="ratings-views">
        <ResultSegmented
          label="Ratings view"
          value={view}
          options={views}
          onChange={setView}
        />
      </div>
      <Toolbar>
        <SecondaryTableSearch
          label={
            library === 'film'
              ? 'Search title or director'
              : 'Search title or artist'
          }
          maxLength={200}
          value={search}
          onChange={setSearch}
        />
        {view === 'ranking' && (
          <>
            <ResultSortPicker
              value={sortKey}
              options={ratingSortOptions(sources, library)}
              onChange={sort}
            />
            <ResultButton
              control="sort-direction"
              icon
              onClick={() => sort(sortKey)}
              aria-label={
                direction === 'desc' ? 'Highest first' : 'Lowest first'
              }
            >
              {direction === 'desc' ? (
                <ArrowDown className="ds-i" />
              ) : (
                <ArrowUp className="ds-i" />
              )}
            </ResultButton>
          </>
        )}
        <ResultToolbarToggle
          control="filters"
          aria-label="Filters"
          pressed={filtersOpen}
          onPressedChange={setFiltersOpen}
          icon={<ListFilter className="ds-i" />}
          count={chips.length || undefined}
        >
          Filters
        </ResultToolbarToggle>
        <ResultToolbarToggle
          control="scoring"
          aria-label="Scoring"
          pressed={scoringOpen}
          onPressedChange={setScoringOpen}
          icon={<SlidersHorizontal className="ds-i" />}
        >
          Scoring
        </ResultToolbarToggle>
        <ToolbarCount>
          <RatingsCount
            text={
              first?.data && shown !== undefined
                ? formatCount(shown) + ' of ' + formatCount(libraryTotal)
                : undefined
            }
            failed={first?.status === 'error'}
          />
        </ToolbarCount>
      </Toolbar>
      {(filtersOpen || scoringOpen) && (
        <div className="ratings-panels">
          {filtersOpen && (
            <RatingsFilters
              key={filterVersion}
              request={request}
              onChange={updateFilters}
            />
          )}
          {scoringOpen && (
            <RatingsScoring
              settings={base.settings}
              sources={sources}
              libraryTotal={libraryTotal}
              onChange={scoring}
            />
          )}
        </div>
      )}
      {chips.length > 0 && (
        <FilterLine>
          {chips.map((c, i) => (
            <BrowseFilterPill
              key={i + '-' + c.label}
              removeLabel={'Clear ' + c.label}
              onRemove={c.clear}
            >
              {c.label}
            </BrowseFilterPill>
          ))}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setSelections([])
              updateFilters(
                {
                  tag: '',
                  tagField: undefined,
                  yearFrom: undefined,
                  yearTo: undefined,
                  watched: undefined,
                  minPlays: undefined,
                },
                true,
              )
            }}
          >
            Clear all
          </Button>
        </FilterLine>
      )}
      {view === 'ranking' ? (
        <Ranking
          request={request}
          ready={readyView === view}
          sources={sources}
          onSources={setSources}
          onCounts={setCounts}
          sort={sort}
          display={display}
          setDisplay={setDisplay}
          onScoredOnly={(scoredOnly) =>
            setRequest((p) => ({ ...p, scoredOnly }))
          }
          onTag={(tag, tagField) =>
            updateFilters({ tag: normalizeTagName(tag), tagField }, true)
          }
        />
      ) : view === 'sources' ? (
        <RatingsSources
          request={shared}
          ready={readyView === view}
          onSources={setSources}
          onSelect={selectRange}
        />
      ) : (
        <RatingsCharts
          view={view}
          request={shared}
          ready={readyView === view}
          axes={axes}
          onSources={setSources}
          onAxes={setAxes}
          onCompare={(next) => {
            setAxes(next)
            setView('compare')
          }}
          onRanking={(sort, direction) => {
            setRequest((p) => ({ ...p, sort, direction }))
            setView('ranking')
          }}
        />
      )}
    </ResultSection>
  )
}
