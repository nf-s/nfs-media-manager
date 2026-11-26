'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  hashKey,
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type {
  RatingsAgreementPage,
  RatingsComparePage,
  RatingsComparePoint,
} from '@repo/schemas/ratings-charts'
import type {
  RatingsSourcesRequest,
  RatingsSource,
} from '@repo/schemas/ratings-explorer'
import {
  RatingAgreementMatrix,
  RatingBiasBar,
  RatingScatter,
  type RatingAxis,
} from '@repo/ui/components/ds/rating-charts'
import { Section, Stats } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Pill, Pills } from '@repo/ui/components/ds/pill'
import { Select } from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import {
  Table,
  TableRow,
  TableBody,
  TableCell,
  TableState,
  TableHead,
  TableHeader,
} from '@repo/ui/components/ui/table'
import { EMPTY_VALUE, formatCount } from '@repo/ui/lib/format'
import { clientQueryDefaults } from '@/utils/query-cache'
import { shortSource } from '@/utils/ratings-explorer-labels'
import {
  fetchAgreement,
  fetchCompare,
  fetchChartCalculation,
  ratingChartsKey,
  type ChartView,
  type ChartAxes,
} from '@/utils/ratings-explorer-charts-api'
import { useConfig } from './providers'
import { RatingsCalculation, nativeScore } from './ratings-explorer-calculation'
import { normalizationLabels } from './ratings-explorer-scoring'
import { ReadButton } from './read-button'
import { ResultButton, useResultAction } from './result-feedback'

type Pair = { x: string; y: string }
type RankingSort = (
  sort: 'spread' | 'criticGap' | 'personalGap',
  direction: 'asc' | 'desc',
) => void
type OpenItem = (id: string) => void

function signed(value: number) {
  const rounded = Math.round(value)
  return (rounded > 0 ? '+' : rounded < 0 ? '−' : '') + Math.abs(rounded)
}
function heading(library: RatingsSourcesRequest['library']) {
  return library === 'film' ? 'Film' : 'Album'
}

function EvidenceTable({
  title,
  note,
  aside,
  library,
  columns,
  rows,
  onOpen,
}: {
  title: string
  note?: string
  aside?: ReactNode
  library: RatingsSourcesRequest['library']
  columns: string[]
  rows: { id: string; title: string; values: ReactNode[] }[]
  onOpen: OpenItem
}) {
  return (
    <Section title={title} aside={aside}>
      {note && <p className="ds-help">{note}</p>}
      <Table aria-label={title}>
        <TableHeader>
          <TableRow>
            <TableHead>{heading(library)}</TableHead>
            {columns.map((c, i) => (
              <TableHead key={i} align="end">
                {c}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id} onClick={() => onOpen(row.id)}>
              <TableCell>
                <Button
                  variant="link"
                  className="ds-cell-title"
                  title={row.title}
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpen(row.id)
                  }}
                >
                  {row.title}
                </Button>
              </TableCell>
              {row.values.map((value, i) => (
                <TableCell key={i} align="end">
                  {value}
                </TableCell>
              ))}
            </TableRow>
          ))}
          {!rows.length && (
            <TableState colSpan={columns.length + 1}>
              No items have both.
            </TableState>
          )}
        </TableBody>
      </Table>
    </Section>
  )
}

const agreementLists: {
  key: keyof RatingsAgreementPage['lists']
  title: string
  note: string
  sort: Parameters<RankingSort>[0]
  direction: 'asc' | 'desc'
}[] = [
  {
    key: 'divided',
    title: 'Most divided',
    note: 'Largest spread among items with three or more counted ratings.',
    sort: 'spread',
    direction: 'desc',
  },
  {
    key: 'criticsHigher',
    title: 'Critics above audiences',
    note: 'Critics’ average minus audiences’ average.',
    sort: 'criticGap',
    direction: 'desc',
  },
  {
    key: 'audiencesHigher',
    title: 'Audiences above critics',
    note: 'The same gap, from the other end.',
    sort: 'criticGap',
    direction: 'asc',
  },
  {
    key: 'personalHigher',
    title: 'I rate above the score',
    note: 'My rating minus the combined score.',
    sort: 'personalGap',
    direction: 'desc',
  },
  {
    key: 'personalLower',
    title: 'I rate below the score',
    note: 'The same gap, from the other end.',
    sort: 'personalGap',
    direction: 'asc',
  },
]

function Agreement({
  page,
  library,
  onCompare,
  onRanking,
  onOpen,
}: {
  page: RatingsAgreementPage
  library: RatingsSourcesRequest['library']
  onCompare: (axes: Pair) => void
  onRanking: RankingSort
  onOpen: OpenItem
}) {
  const rankingAction = useResultAction('Ratings view-ranking')
  const compareAction = useResultAction('Ratings view-compare')
  const maxRun = Math.max(
    5,
    ...page.bias.map((source) => Math.abs(source.runs ?? 0)),
  )
  const maxStray = Math.max(5, ...page.bias.map((source) => source.strays ?? 0))
  const personal = page.sources.some((source) => source.group === 'personal')
  return (
    <>
      <div className="ds-rating-chart-grid">
        <Section title="How closely each pair of sources agrees">
          <p className="ds-help">
            Correlation across the items both have rated: 1 is full agreement, 0
            is none. Pick a cell to compare that pair.
          </p>
          <RatingAgreementMatrix
            sources={page.sources.map((source) => ({
              ...source,
              shortLabel: shortSource(source, library),
            }))}
            pairs={page.pairs}
            onCompare={(pair) => {
              compareAction.begin()
              onCompare(pair)
            }}
          />
        </Section>
        <Section title="How each source sits against the others">
          <p className="ds-help">
            Runs: its average distance above or below the other public sources
            on a plain 0–100 scale. Strays: its typical distance from them after
            adjustment. Furthest: how often it is the rating furthest from the
            rest.
          </p>
          <Table aria-label="Source bias">
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Runs</TableHead>
                <TableHead>Strays</TableHead>
                <TableHead align="end">Furthest</TableHead>
                <TableHead align="end">Items</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.sources.map((source) => {
                const bias = page.bias.find((row) => row.key === source.key)
                return (
                  <TableRow key={source.key}>
                    <TableCell title={source.label}>
                      {shortSource(source, library)}
                    </TableCell>
                    <TableCell>
                      {bias?.runs == null ? (
                        EMPTY_VALUE
                      ) : (
                        <RatingBiasBar
                          value={bias.runs}
                          maximum={maxRun}
                          label={signed(bias.runs)}
                          diverging
                        />
                      )}
                    </TableCell>
                    <TableCell>
                      {bias?.strays == null ? (
                        EMPTY_VALUE
                      ) : (
                        <RatingBiasBar
                          value={bias.strays}
                          maximum={maxStray}
                          label={String(Math.round(bias.strays))}
                        />
                      )}
                    </TableCell>
                    <TableCell align="end">
                      {bias?.furthest == null
                        ? EMPTY_VALUE
                        : Math.round(bias.furthest * 100) + '%'}
                    </TableCell>
                    <TableCell align="end">
                      {formatCount(bias?.items ?? 0)}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </Section>
      </div>
      <div className="ds-rating-chart-grid">
        {agreementLists
          .filter((list) => list.sort !== 'personalGap' || personal)
          .map((list) => (
            <EvidenceTable
              key={list.key}
              title={list.title}
              note={list.note}
              library={library}
              columns={[list.sort === 'spread' ? 'Spread' : 'Gap', 'Score']}
              rows={page.lists[list.key].map((row) => ({
                ...row,
                values: [
                  list.sort === 'spread'
                    ? Math.round(row.value)
                    : signed(row.value),
                  row.score === null ? EMPTY_VALUE : Math.round(row.score),
                ],
              }))}
              aside={
                <Button
                  size="xs"
                  aria-label={'See all: ' + list.title}
                  onClick={() => {
                    rankingAction.begin()
                    onRanking(list.sort, list.direction)
                  }}
                >
                  See all
                </Button>
              }
              onOpen={onOpen}
            />
          ))}
      </div>
    </>
  )
}

function valueFor(
  point: RatingsComparePoint,
  key: 'x' | 'y',
  axis: RatingAxis,
  sources: RatingsSource[],
) {
  const source = sources.find((source) => source.key === axis.key)
  const value = Math.round(point[key])
  return source ? (
    <>
      {nativeScore(key === 'x' ? point.xRaw : point.yRaw, source.scale)}{' '}
      <span className="ds-muted">({value})</span>
    </>
  ) : (
    value
  )
}
function Compare({
  page,
  request,
  axes,
  pending,
  onAxes,
  onOpen,
}: {
  page: RatingsComparePage
  request: RatingsSourcesRequest
  axes: ChartAxes
  pending: boolean
  onAxes: (pair: Pair) => void
  onOpen: OpenItem
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const compareAction = useResultAction('Ratings view-compare')
  const options: RatingAxis[] = [
    { key: 'score', label: 'Score' },
    { key: 'spread', label: 'Spread' },
    { key: 'critics', label: 'Critics, average' },
    { key: 'audience', label: 'Audiences, average' },
    ...page.sources.map((source) => ({
      ...source,
      shortLabel: shortSource(source, request.library),
    })),
    { key: 'year', label: 'Year' },
  ]
  const x = options.find(
    (axis) => axis.key === (pending ? (axes.x ?? page.x) : page.x),
  )
  const y = options.find(
    (axis) => axis.key === (pending ? (axes.y ?? page.y) : page.y),
  )
  if (!x || !y) return null
  const acrossName = x.shortLabel ?? x.label
  const upName = y.shortLabel ?? y.label
  const bothRated = [x, y].every(
    (axis) => axis.key !== 'year' && axis.key !== 'spread',
  )
  const picked = page.points.find((point) => point.id === selected)
  const axisControl = (label: string, key: 'x' | 'y', current: RatingAxis) => (
    <label className="ds-actions">
      <span className="ds-label">{label}</span>
      <Select
        aria-label={label}
        value={current.key}
        onChange={(event) => {
          compareAction.begin()
          setSelected(null)
          onAxes({ x: x.key, y: y.key, [key]: event.target.value })
        }}
      >
        {options.map((axis) => (
          <option key={axis.key} value={axis.key}>
            {axis.label}
          </option>
        ))}
      </Select>
    </label>
  )
  return (
    <>
      <div className="ds-rating-chart-controls">
        {axisControl('Across', 'x', x)}
        {axisControl('Up', 'y', y)}
        <ResultButton
          control="swap"
          size="sm"
          track={x.key !== y.key}
          onClick={() => onAxes({ x: y.key, y: x.key })}
        >
          Swap
        </ResultButton>
      </div>
      {!pending && (
        <>
          <Stats
            items={[
              {
                label: 'of ' + formatCount(page.total) + ' have both',
                value: formatCount(page.count),
              },
              ...(page.correlation === null
                ? []
                : [
                    {
                      label: 'Correlation',
                      value: page.correlation.toFixed(2),
                    },
                  ]),
              ...(bothRated && page.meanGap !== null
                ? [
                    {
                      label: upName + ' − ' + acrossName + ', average',
                      value: signed(page.meanGap),
                    },
                  ]
                : []),
            ]}
          />
          <div className="ds-rating-chart-grid">
            <div className="ds-rating-chart-stack">
              <RatingScatter
                x={{ ...x, min: page.xMin, max: page.xMax }}
                y={{ ...y, min: page.yMin, max: page.yMax }}
                points={page.points}
                selected={picked?.id ?? null}
                bothRated={bothRated}
                onSelect={setSelected}
                onOpen={onOpen}
              />
              {page.count > page.points.length && (
                <p className="ds-help">
                  Plot shows {formatCount(page.points.length)} of{' '}
                  {formatCount(page.count)} matching items. Statistics and lists
                  include every match.
                </p>
              )}
              {bothRated && (
                <>
                  <Pills wrap>
                    <Pill mode="any">{upName} 20+ higher</Pill>
                    <Pill tone="attention">{acrossName} 20+ higher</Pill>
                  </Pills>
                  <p className="ds-help">
                    Rated axes are adjusted to 0–100 (
                    {normalizationLabels[
                      request.settings.normalization
                    ].toLowerCase()}
                    ). On the dashed line both agree.
                  </p>
                </>
              )}
              <div className="ds-rating-picked" role="status">
                {picked ? (
                  <>
                    <strong>{picked.title}</strong>
                    <span className="ds-muted">{picked.year}</span>
                    <span>
                      {x.label} {valueFor(picked, 'x', x, page.sources)}
                    </span>
                    <span>
                      {y.label} {valueFor(picked, 'y', y, page.sources)}
                    </span>
                    <Button size="xs" onClick={() => onOpen(picked.id)}>
                      Open
                    </Button>
                  </>
                ) : (
                  <span className="ds-muted">
                    Pick a point to see the item.
                  </span>
                )}
              </div>
            </div>
            {bothRated && (
              <div className="ds-rating-chart-stack">
                {[
                  { axis: y, rows: page.yHigher },
                  { axis: x, rows: page.xHigher },
                ].map(({ axis, rows }, i) => (
                  <EvidenceTable
                    key={i}
                    title={axis.label + ' higher'}
                    library={request.library}
                    columns={[acrossName, upName, 'Gap']}
                    rows={rows.map((point) => ({
                      ...point,
                      values: [
                        valueFor(point, 'x', x, page.sources),
                        valueFor(point, 'y', y, page.sources),
                        signed(point.y - point.x),
                      ],
                    }))}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </>
  )
}

export function RatingsCharts({
  view,
  request,
  ready,
  axes,
  onAxes,
  onCompare,
  onRanking,
  onSources,
}: {
  view: ChartView
  request: RatingsSourcesRequest
  ready: boolean
  axes: ChartAxes
  onAxes: (axes: Pair) => void
  onCompare: (axes: Pair) => void
  onRanking: RankingSort
  onSources: (sources: RatingsSource[]) => void
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const agreement = useQuery({
    queryKey: ratingChartsKey('agreement', request, axes),
    queryFn: ({ signal }) => fetchAgreement(apiBaseUrl, request, signal),
    ...clientQueryDefaults,
    enabled: ready && view === 'agreement',
    retry: false,
  })
  const compare = useQuery({
    queryKey: ratingChartsKey('compare', request, axes),
    queryFn: ({ signal }) =>
      fetchCompare(apiBaseUrl, { ...request, ...axes }, signal),
    ...clientQueryDefaults,
    placeholderData: keepPreviousData,
    enabled: ready && view === 'compare',
    retry: false,
  })
  const active = view === 'agreement' ? agreement : compare
  const sources = active.data?.sources
  useEffect(() => {
    if (sources && !active.isPlaceholderData) onSources(sources)
  }, [sources, active.isPlaceholderData, onSources])
  const identity = hashKey(ratingChartsKey(view, request, axes))
  const [selection, setSelection] = useState<{
    id: string
    identity: string
  } | null>(null)
  if (selection && selection.identity !== identity) setSelection(null)
  const id = selection?.identity === identity ? selection.id : null
  const evidence = useQuery({
    queryKey: [
      request.library + 's',
      'ratings-explorer',
      'calculation',
      request,
      id,
    ],
    queryFn: ({ signal }) =>
      id === null
        ? null
        : fetchChartCalculation(client, apiBaseUrl, request, id, signal),
    ...clientQueryDefaults,
    enabled: id !== null,
    retry: false,
  })
  const close = useCallback(() => setSelection(null), [])
  const open = (id: string) => setSelection({ id, identity })
  return (
    <div
      className="sec-scroll ratings-sources ds-rating-chart-stack"
      role="region"
      aria-label={
        view === 'agreement' ? 'Rating agreement' : 'Rating comparison'
      }
      aria-busy={active.isFetching}
    >
      {active.isError && (
        <Notice
          tone="danger"
          action={
            <ReadButton size="xs" read={() => active.refetch()}>
              Retry
            </ReadButton>
          }
        >
          Could not load rating {view}.
        </Notice>
      )}
      {active.isPending && (
        <p role="status" className="ds-muted">
          Loading ratings…
        </p>
      )}
      {view === 'agreement' && agreement.data && (
        <Agreement
          page={agreement.data}
          library={request.library}
          onCompare={onCompare}
          onRanking={onRanking}
          onOpen={open}
        />
      )}
      {view === 'compare' && compare.data && (
        <Compare
          request={request}
          page={compare.data}
          axes={axes}
          pending={compare.isPlaceholderData}
          onAxes={onAxes}
          onOpen={open}
        />
      )}
      {id &&
        (evidence.data && sources ? (
          <RatingsCalculation
            library={request.library}
            row={evidence.data}
            sources={sources}
            settings={request.settings}
            onClose={close}
          />
        ) : (
          <Notice
            tone={evidence.isError ? 'danger' : undefined}
            action={
              <Button size="xs" onClick={close}>
                Close
              </Button>
            }
          >
            {evidence.isError ? (
              <>
                <span>Could not load the calculation. </span>
                <ReadButton size="xs" read={() => evidence.refetch()}>
                  Retry
                </ReadButton>
              </>
            ) : evidence.data === null ? (
              'This item is no longer in the results.'
            ) : (
              'Loading calculation…'
            )}
          </Notice>
        ))}
    </div>
  )
}
