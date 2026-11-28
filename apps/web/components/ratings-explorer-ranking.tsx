'use client'

import { useCallback, useEffect, useState } from 'react'
import { hashKey, useQueryClient } from '@tanstack/react-query'
import type {
  RatingsRankingRequest,
  RatingsRankingRow,
  RatingsSource,
} from '@repo/schemas/ratings-explorer'
import { Notice } from '@repo/ui/components/ds/feedback'
import { EmptyValue, Rating } from '@repo/ui/components/ds/pill'
import { RatingDifference } from '@repo/ui/components/ds/ratings-explorer'
import { Segmented } from '@repo/ui/components/ds/segmented'
import { FilterLine } from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import {
  columnWidth,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableState,
} from '@repo/ui/components/ui/table'
import { formatCount, EMPTY_VALUE } from '@repo/ui/lib/format'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { shortSource } from '@/utils/ratings-explorer-labels'
import { fetchRatingsRanking, rankingKey } from '@/utils/ratings-explorer-api'
import { BrowseTagBadges } from './browse-controls'
import { CreatorLinks } from './creator-links'
import { DetailLink } from './detail-link'
import { MediaThumb } from './media-artwork'
import { AlbumInlinePlayButton } from './play-controls'
import { libraryItemMore } from './item-more'
import { useConfig } from './providers'
import { ReadButton } from './read-button'
import { RatingsCalculation, nativeScore } from './ratings-explorer-calculation'
import { settingFor } from './ratings-explorer-scoring'
import {
  SecondaryTableHead,
  SecondaryTableScroll,
  SecondaryVirtualRows,
  useTableWidths,
  type TableColumn,
} from './secondary-table'

type Library = RatingsRankingRequest['library']
type Display = 'native' | 'adjusted'
type Column = TableColumn & {
  text?: boolean
  sortable?: false
  sortLabel?: string
}
type Counts = { total: number; libraryTotal: number; unscored: number }
type Props = {
  request: RatingsRankingRequest
  ready: boolean
  sources: RatingsSource[]
  onSources: (sources: RatingsSource[]) => void
  onCounts: (counts: Counts) => void
  sort: (key: string) => void
  display: Display
  setDisplay: (display: Display) => void
  onScoredOnly: (hide: boolean) => void
  onTag: (tag: string, field?: 'artistTag') => void
}

const displayModes: { value: Display; label: string }[] = [
  { value: 'native', label: 'Source values' },
  { value: 'adjusted', label: 'Adjusted 0–100' },
]

export function ratingSortOptions(
  sources: readonly RatingsSource[],
  library: Library,
) {
  return [
    { key: 'score', label: 'Score' },
    { key: 'spread', label: 'Spread' },
    { key: 'criticGap', label: 'Critics − audiences' },
    ...(library === 'film' &&
    sources.some((source) => source.group === 'personal')
      ? [{ key: 'personalGap', label: 'Mine − score' }]
      : []),
    ...sources.map(({ key, label }) => ({ key, label })),
    { key: 'counted', label: 'Ratings counted' },
    { key: 'year', label: 'Year' },
    { key: 'title', label: 'Title' },
  ]
}

// Native source columns follow the Explorer's reading order. Registry fields
// added by plugins follow these and keep their own labels and relative order.
const nativeColumns: Record<
  Library,
  { key: string; label: string; width: number }[]
> = {
  film: [
    { key: 'ratingImdbPersonal', label: 'Mine', width: 41 },
    { key: 'ratingImdbValue', label: 'IMDb', width: 44 },
    { key: 'ratingTmdbValue', label: 'TMDb', width: 46 },
    { key: 'ratingTrakt', label: 'Trakt', width: 43 },
    { key: 'ratingLetterboxd', label: 'Lbxd', width: 42 },
    { key: 'ratingRtAudience', label: 'RT aud', width: 52 },
    { key: 'ratingMetacriticUser', label: 'MC users', width: 64 },
    { key: 'ratingRt', label: 'RT', width: 40 },
    { key: 'ratingMetascore', label: 'Meta', width: 42 },
  ],
  album: [
    { key: 'ratingRymValue', label: 'RYM', width: 46 },
    { key: 'ratingDiscogsValue', label: 'Discogs', width: 58 },
    { key: 'ratingMetacriticValue', label: 'Meta', width: 42 },
  ],
}

export function rankingSourceColumns(
  sources: readonly RatingsSource[],
  library: Library,
) {
  const native = nativeColumns[library]
  return [
    ...native.flatMap((column) => {
      const source = sources.find(({ key }) => key === column.key)
      return source ? [{ ...column, sortLabel: source.label }] : []
    }),
    ...sources
      .filter((source) => !native.some(({ key }) => key === source.key))
      .map((source) => {
        const label = shortSource(source, library)
        return {
          key: source.key,
          label,
          sortLabel: source.label,
          width: Math.max(44, Math.min(190, label.length * 8 + 18)),
        }
      }),
  ]
}

function ratingColumns(
  sources: readonly RatingsSource[],
  library: Library,
): Column[] {
  const position: Column = {
    key: 'position',
    label: '#',
    width: 44,
    sortable: false,
  }
  const identity: Column = {
    key: 'title',
    label: library === 'album' ? 'Album' : 'Film',
    width: library === 'album' ? 224 : 200,
    text: true,
  }
  return [
    ...(library === 'album'
      ? [
          identity,
          {
            key: 'actions',
            label: 'Playback',
            width: 82,
            sortable: false,
            text: true,
          } satisfies Column,
          position,
        ]
      : [position, identity]),
    { key: 'score', label: 'Score', width: 62 },
    { key: 'spread', label: 'Spread', width: 54 },
    { key: 'counted', label: 'Counted', width: 60 },
    {
      key: 'furthest',
      label: 'Furthest',
      width: 93,
      text: true,
      sortable: false,
    },
    { key: 'criticGap', label: 'Crit − aud', width: 68 },
    ...(library === 'film' && sources.some((s) => s.group === 'personal')
      ? [{ key: 'personalGap', label: 'Mine − score', width: 85 }]
      : []),
    ...rankingSourceColumns(sources, library),
    { key: 'year', label: 'Year', width: 49 },
    ...(library === 'film'
      ? [
          {
            key: 'creator',
            label: 'Director',
            width: 124,
            text: true,
            sortable: false,
          } satisfies Column,
        ]
      : []),
    { key: 'tags', label: 'Tags', width: 220, text: true, sortable: false },
  ]
}

/** The prototype compares each qualifying rating with the mean of the others. */
export function furthestRating(row: Pick<RatingsRankingRow, 'ratings'>) {
  const counted = row.ratings.flatMap((r) =>
    (r.status === 'counted' || r.status === 'trimmed') && r.adjusted !== null
      ? [{ key: r.key, value: r.adjusted }]
      : [],
  )
  if (counted.length < 3) return null
  const sum = counted.reduce((total, r) => total + r.value, 0)
  let best: { key: string; difference: number } | null = null
  for (const r of counted) {
    const difference = r.value - (sum - r.value) / (counted.length - 1)
    if (Math.abs(difference) > Math.abs(best?.difference ?? 0))
      best = { key: r.key, difference }
  }
  return best && Math.abs(best.difference) >= 10 ? best : null
}

const signed = new Intl.NumberFormat('en', {
  maximumFractionDigits: 0,
  signDisplay: 'exceptZero',
})
function rowCreators(row: RatingsRankingRow, library: Library) {
  return row.credits.length ? (
    <CreatorLinks
      creators={row.credits}
      kind={library === 'album' ? 'artist' : 'person'}
    />
  ) : (
    <EmptyValue />
  )
}

function RatingCell({
  column,
  row,
  index,
  library,
  sources,
  sourceCount,
  display,
  onOpen,
  onTag,
}: {
  column: string
  row: RatingsRankingRow
  index: number
  library: Library
  sources: RatingsSource[]
  sourceCount: number
  display: Display
  onOpen: () => void
  onTag: Props['onTag']
}) {
  switch (column) {
    case 'title':
      if (library === 'film')
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
      return (
        <span className="ds-cell-id">
          <DetailLink
            kind="album"
            id={row.id}
            className="browse-thumb-link"
            workspaceLabel={row.title}
            tabIndex={-1}
            aria-hidden="true"
          >
            <MediaThumb kind="album" src={row.artworkUrl} />
          </DetailLink>
          <span className="ds-cell-two">
            <DetailLink
              kind="album"
              id={row.id}
              className="ds-cell-title"
              title={row.title}
            >
              {row.title}
            </DetailLink>
            <span className="ds-cell-sub">{rowCreators(row, library)}</span>
          </span>
        </span>
      )
    case 'actions':
      return row.album ? (
        <AlbumInlinePlayButton
          album={{
            id: row.id,
            title: row.title,
            credits: row.credits,
            artworkUrl: row.artworkUrl,
            ...row.album,
          }}
          more={libraryItemMore('albums', row)}
        />
      ) : (
        <EmptyValue />
      )
    case 'position':
      return formatCount(index + 1)
    case 'score':
      return (
        <Button
          variant="ghost"
          size="xs"
          aria-label={'Combined score calculation for ' + row.title}
          onClick={onOpen}
        >
          {row.score === null ? EMPTY_VALUE : Math.round(row.score)}
        </Button>
      )
    case 'counted':
      return row.counted + '/' + sourceCount
    case 'spread':
      return row.spread === null ? EMPTY_VALUE : Math.round(row.spread)
    case 'criticGap':
    case 'personalGap':
      return row[column] === null ? EMPTY_VALUE : signed.format(row[column])
    case 'year':
      return row.year ?? EMPTY_VALUE
    case 'creator':
      return rowCreators(row, library)
    case 'tags':
      return row.tags.length || row.artistTags.length ? (
        <BrowseTagBadges
          tags={row.tags}
          artistTags={library === 'album' ? row.artistTags : undefined}
          max={2}
          onFilter={(filter) =>
            onTag(
              filter.value,
              filter.field === 'artistTag' ? 'artistTag' : undefined,
            )
          }
        />
      ) : (
        <EmptyValue />
      )
    case 'furthest': {
      const far = furthestRating(row)
      const source = far && sources.find((s) => s.key === far.key)
      return far && source ? (
        <Rating
          source={
            nativeColumns[library].find(({ key }) => key === source.key)
              ?.label ?? shortSource(source, library)
          }
          value={signed.format(far.difference)}
          title={source.label + ' compared with the other counted ratings'}
        />
      ) : (
        <EmptyValue />
      )
    }
    default: {
      const source = sources.find((s) => s.key === column)
      const rating = row.ratings.find((r) => r.key === column)
      if (!source || !rating || rating.raw === null || rating.adjusted === null)
        return <EmptyValue />
      return (
        <RatingDifference
          compact
          value={
            display === 'native'
              ? nativeScore(rating.raw, source.scale)
              : String(Math.round(rating.adjusted))
          }
          status={rating.status}
          difference={row.score === null ? null : rating.adjusted - row.score}
          label={
            source.label +
            ' calculation for ' +
            row.title +
            ', ' +
            rating.status
          }
          onClick={onOpen}
        />
      )
    }
  }
}

export function Ranking({
  request,
  ready,
  sources: knownSources,
  onSources,
  onCounts,
  sort,
  display,
  setDisplay,
  onScoredOnly,
  onTag,
}: Props) {
  const { library } = request
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [limit, setLimit] = useState(100)
  const [scrolledSideways, setScrolledSideways] = useState(false)
  const [calculation, setCalculation] = useState<RatingsRankingRow | null>(null)
  const close = useCallback(() => setCalculation(null), [])
  const queryKey = rankingKey(request)
  const identity = hashKey(queryKey)
  const [previousIdentity, setPreviousIdentity] = useState(identity)
  if (previousIdentity !== identity) {
    setPreviousIdentity(identity)
    setLimit(100)
    setCalculation(null)
  }
  const first = client.getQueryData<{ visibleTotal: number }>([...queryKey, 1])
  const query = useVirtualTable({
    queryKey,
    pageSize: request.limit,
    // The shared table's two-line row is 44px; its virtual spacers use the same height.
    rowHeight: library === 'album' ? 44 : undefined,
    enabled: ready,
    totalCount: first ? Math.min(first.visibleTotal, limit) : undefined,
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
        visibleTotal: result.total,
        counts: {
          total: result.matchingTotal,
          libraryTotal: result.libraryTotal,
          unscored: result.unscored,
        },
        sources: result.sources,
        pageTiming: { requestedAt, readyAt: performance.now() },
      }
    },
  })
  const data = query.firstPage
  useEffect(() => {
    if (data) {
      onSources(data.sources)
      onCounts(data.counts)
    }
  }, [data, onSources, onCounts])
  const sources = data?.sources ?? knownSources
  const count = sources.filter(
    (s) => settingFor(s, request.settings).weight > 0,
  ).length
  const columns = ratingColumns(sources, library).map((column) =>
    column.key === request.sort && column.key !== 'score' && column.width
      ? { ...column, width: column.width + 16 }
      : column,
  )
  const widths = useTableWidths('ratings-ranking-' + library, columns)
  const layout = widths.layout(columns.map((c) => c.key))
  const label = library === 'film' ? 'Film rankings' : 'Album rankings'
  return (
    <>
      <FilterLine>
        <Segmented
          label="Rating columns show"
          options={displayModes}
          value={display}
          onChange={setDisplay}
        />
        <span className="ds-rating-key" data-direction="high">
          20+ above the score
        </span>
        <span className="ds-rating-key" data-direction="low">
          20+ below
        </span>
        <span>
          <s>struck</s> = left out
        </span>
        <label className="ds-checkrow">
          <input
            className="ds-check"
            type="checkbox"
            checked={request.scoredOnly}
            onChange={(e) => onScoredOnly(e.target.checked)}
          />
          Hide {data ? formatCount(data.counts.unscored) + ' ' : ''}without a
          score
        </label>
      </FilterLine>
      {query.isError && (
        <Notice
          tone="danger"
          action={
            <ReadButton size="xs" read={query.retry}>
              Retry
            </ReadButton>
          }
        >
          Could not load rankings.
        </Notice>
      )}
      <SecondaryTableScroll
        ref={query.scroller}
        onScroll={(event) => {
          query.onScroll(event)
          setScrolledSideways(event.currentTarget.scrollLeft > 0)
        }}
        data-pin-identity=""
        style={{
          scrollPaddingInlineStart: columnWidth(widths.widthFor('title')),
        }}
        role="region"
        aria-label={label}
        aria-busy={query.isFetching}
      >
        <table
          className="ds-table"
          {...layout.table}
          data-density="compact"
          data-pin-identity=""
          data-scrolled={scrolledSideways ? '' : undefined}
          data-rows={library === 'album' ? 'two' : undefined}
          aria-label={label}
          aria-rowcount={query.hasTotal ? query.total + 1 : undefined}
        >
          {layout.colgroup}
          <TableHeader>
            <TableRow>
              {columns.map((c) => {
                const align: 'end' | undefined = c.text ? undefined : 'end'
                const shared = {
                  align,
                  sticky: c.key === 'title' ? 0 : undefined,
                  stickyEdge: c.key === 'title',
                  resizer: widths.resizer(c.key),
                }
                return c.sortable === false ? (
                  <TableHead key={c.key} {...shared}>
                    {c.label}
                  </TableHead>
                ) : (
                  <SecondaryTableHead
                    key={c.key}
                    {...shared}
                    label={c.label}
                    sortLabel={c.sortLabel}
                    sortKey={c.key}
                    sortBy={request.sort}
                    direction={request.direction}
                    onSort={sort}
                  />
                )
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.hasTotal && query.total === 0 && (
              <TableState colSpan={columns.length}>
                No items match. Remove a filter or lower the minimum number of
                ratings in Scoring.
              </TableState>
            )}
            <SecondaryVirtualRows
              window={query}
              colSpan={columns.length}
              renderRow={(item, index) => (
                <TableRow
                  key={item.id}
                  aria-rowindex={index + 2}
                  selected={calculation?.id === item.id}
                  style={{ height: query.rowHeight }}
                  onClick={(event) => {
                    if (
                      event.target instanceof Element &&
                      !event.target.closest('a,button,input')
                    )
                      setCalculation(item)
                  }}
                >
                  {columns.map((c) => (
                    <TableCell
                      key={c.key}
                      sticky={c.key === 'title' ? 0 : undefined}
                      stickyEdge={c.key === 'title'}
                      align={c.text ? undefined : 'end'}
                    >
                      <RatingCell
                        column={c.key}
                        row={item}
                        index={index}
                        library={library}
                        sources={sources}
                        sourceCount={count}
                        display={display}
                        onOpen={() => setCalculation(item)}
                        onTag={onTag}
                      />
                    </TableCell>
                  ))}
                </TableRow>
              )}
            />
          </TableBody>
        </table>
      </SecondaryTableScroll>
      {data && data.visibleTotal > limit && (
        <div className="ds-tablefoot">
          Showing {formatCount(limit)} of {formatCount(data.visibleTotal)}{' '}
          <Button size="xs" onClick={() => setLimit((n) => n + 200)}>
            Show 200 more
          </Button>
        </div>
      )}
      {calculation && (
        <RatingsCalculation
          row={calculation}
          sources={sources}
          settings={request.settings}
          library={library}
          onClose={close}
        />
      )}
    </>
  )
}
