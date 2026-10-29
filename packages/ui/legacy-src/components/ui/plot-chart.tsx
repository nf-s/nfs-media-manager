'use client'

import {
  type AppearanceConfig,
  type CategoricalColorScheme,
  type CurveType,
  getContrastingTextColor,
  makeDateFormatter,
  type OnSelectCallback,
  type PlotSubType,
} from '@repo/plot/types'
import {
  schemeAccent,
  schemeCategory10,
  schemeDark2,
  schemeObservable10,
  schemePaired,
  schemeSet1,
  schemeSet2,
  schemeSet3,
  schemeTableau10,
} from 'd3-scale-chromatic'
import { type MouseEvent as ReactMouseEvent, useCallback, useMemo } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
} from 'recharts'
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
} from './chart'

// ---------------------------------------------------------------------------
// Categorical colour palettes
// ---------------------------------------------------------------------------

const CATEGORICAL_SCHEMES: Record<CategoricalColorScheme, readonly string[]> = {
  tableau10: schemeTableau10,
  category10: schemeCategory10,
  paired: schemePaired,
  set1: schemeSet1,
  set2: schemeSet2,
  set3: schemeSet3,
  dark2: schemeDark2,
  accent: schemeAccent,
  observable10: schemeObservable10,
}

function getScheme(name?: CategoricalColorScheme): readonly string[] {
  return CATEGORICAL_SCHEMES[name ?? 'tableau10'] ?? schemeTableau10
}

function getColor(
  index: number,
  scheme?: CategoricalColorScheme,
  overrides?: Record<string, string>,
  seriesKey?: string | string[],
) {
  if (seriesKey) {
    const lookupKeys = Array.isArray(seriesKey) ? seriesKey : [seriesKey]
    for (const key of lookupKeys) {
      if (overrides?.[key]) return overrides[key]
    }
  }
  const palette = getScheme(scheme)
  return palette[index % palette.length]!
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function makeNumberFormatter(
  decimalPlaces?: number,
  compact?: boolean,
): Intl.NumberFormat {
  const opts: Intl.NumberFormatOptions = {
    notation: compact ? 'compact' : undefined,
  }
  // Only override maximumFractionDigits when explicitly configured — compact
  // notation picks sensible defaults on its own.
  if (decimalPlaces !== undefined) {
    opts.maximumFractionDigits = decimalPlaces
  } else if (!compact) {
    opts.maximumFractionDigits = 3
  }
  return new Intl.NumberFormat(undefined, opts)
}

function makeFormatXAxis(dateFmt: Intl.DateTimeFormat) {
  return function formatXAxis(value: unknown): string {
    if (value instanceof Date) {
      return dateFmt.format(value)
    }
    if (typeof value === 'string') {
      const date = new Date(value)
      if (!isNaN(date.getTime())) {
        return dateFmt.format(date)
      }
    }
    return String(value ?? '')
  }
}

function makeFormatValue(numFmt: Intl.NumberFormat) {
  return function formatValue(value: unknown): string {
    if (typeof value === 'number') {
      return numFmt.format(value)
    }
    return String(value ?? '')
  }
}

// ---------------------------------------------------------------------------
// Data transformation helpers
// ---------------------------------------------------------------------------

interface BasePlotRecord {
  id: string
  value: number
  [key: string]: unknown
}

/** Read a dynamic string key from a record, returning `unknown`. */
function field(record: Record<string, unknown>, key: string): unknown {
  return record[key]
}

/** Read a dynamic string key from a record and coerce to number (or 0). */
function numericField(record: Record<string, unknown>, key: string): number {
  const v = record[key]
  return typeof v === 'number' ? v : 0
}

/** Normalise a value to a stable string key (ISO for Dates). */
function toStringKey(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return String(value ?? '')
}

function toSeriesKey(value: unknown): string {
  const key = toStringKey(value)
  return key === '' ? 'Value' : key
}

/**
 * Pivots flat records into the wide-format Recharts expects for cartesian
 * charts (line, area, bar).
 *
 * **INVARIANT**: Every (x, groupBy) combination must appear at most once in the
 * input data.  Each cell in the pivoted table maps 1:1 to a single product
 * output — no aggregation, summarisation, or silent overwriting is ever
 * performed.  If a collision is detected the function returns an error string
 * instead of data.
 *
 * x-values are normalised to strings so Recharts payloads and original-record
 * lookups always compare consistently.
 */
function pivotData(
  data: Record<string, unknown>[],
  x: string,
  y: string,
  groupBy: string,
):
  | { pivoted: Record<string, unknown>[]; seriesKeys: string[]; error?: never }
  | { error: string; pivoted?: never; seriesKeys?: never } {
  const seriesSet = new Set<string>()
  const grouped = new Map<string, Record<string, unknown>>()

  for (const item of data) {
    const xKey = toStringKey(field(item, x))
    const groupValue = toSeriesKey(field(item, groupBy))
    const yValue = numericField(item, y)

    seriesSet.add(groupValue)

    if (!grouped.has(xKey)) {
      grouped.set(xKey, { [x]: xKey })
    }

    const row = grouped.get(xKey)!

    // 1:1 invariant — never overwrite an existing value.
    if (groupValue in row) {
      return {
        error:
          `Data has multiple values for (${x}=${xKey}, ${groupBy}=${groupValue}). ` +
          'Each chart element must map to exactly one product output — ' +
          'narrow your selection so only one dimension varies per axis.',
      }
    }

    row[groupValue] = yValue
  }

  const seriesKeys = Array.from(seriesSet)
  const pivoted = Array.from(grouped.values()).sort((a, b) =>
    String(a[x]).localeCompare(String(b[x])),
  )

  return { pivoted, seriesKeys }
}

/**
 * Prepares donut chart data — 1:1 mapping from original records to slices.
 * No aggregation: each record becomes its own slice.
 */
interface DonutSlice {
  name: string
  value: number
  fill: string
  originalIndex: number
}

interface FormatFn {
  // eslint-disable-next-line no-unused-vars
  (input: unknown): string
}

function prepareDonutSlices(
  data: Record<string, unknown>[],
  x: string,
  y: string,
  groupBy: string,
  fmtX: FormatFn,
  scheme?: CategoricalColorScheme,
  overrides?: Record<string, string>,
): DonutSlice[] {
  // Build a stable colour index per unique group value so all slices in the
  // same group share a colour (e.g. all "Carbon" slices are the same hue).
  const groupIndex = new Map<string, number>()
  for (const item of data) {
    const grp = toSeriesKey(field(item, groupBy))
    if (!groupIndex.has(grp)) {
      groupIndex.set(grp, groupIndex.size)
    }
  }

  return data.map((item, index) => {
    const grp = toSeriesKey(field(item, groupBy))
    // When x === groupBy (e.g. both 'timePoint') just use the formatted value;
    // otherwise combine group + x for a unique label.
    const name =
      x === groupBy ? fmtX(field(item, x)) : `${grp} — ${fmtX(field(item, x))}`
    // Use the formatted label as the override key when x === groupBy so the
    // colour-override UI (which shows formatted names) matches.
    const colorKey = x === groupBy ? [fmtX(field(item, groupBy)), grp] : grp
    return {
      name,
      value: numericField(item, y),
      // Use the group value for override lookup so that a single override
      // key (e.g. "Carbon") colours every slice belonging to that group.
      fill: getColor(groupIndex.get(grp) ?? index, scheme, overrides, colorKey),
      originalIndex: index,
    }
  })
}

/**
 * Groups flat records by the `groupBy` field — used for scatter charts
 * where each series needs its own data array.
 */
function groupBySeries<T extends BasePlotRecord>(
  data: T[],
  groupBy: string,
  sortBy?: string,
): { seriesKey: string; seriesData: T[] }[] {
  const groups = new Map<string, T[]>()

  for (const item of data) {
    const key = toSeriesKey(field(item, groupBy))
    if (!groups.has(key)) {
      groups.set(key, [])
    }
    groups.get(key)!.push(item)
  }

  return Array.from(groups.entries()).map(([seriesKey, seriesData]) => ({
    seriesKey,
    seriesData: sortBy
      ? seriesData.sort((a, b) =>
          toStringKey(field(a, sortBy)).localeCompare(
            toStringKey(field(b, sortBy)),
          ),
        )
      : seriesData,
  }))
}

// ---------------------------------------------------------------------------
// Dynamic ChartConfig builders
// ---------------------------------------------------------------------------

function buildChartConfig(
  seriesKeys: string[],
  scheme?: CategoricalColorScheme,
  overrides?: Record<string, string>,
  getSeriesLabel: (seriesKey: string) => string = (seriesKey) => seriesKey,
): ChartConfig {
  const config: ChartConfig = {}
  seriesKeys.forEach((key, index) => {
    const label = getSeriesLabel(key)
    config[key] = {
      label,
      color: getColor(index, scheme, overrides, [label, key]),
    }
  })
  return config
}

function buildDonutConfig(slices: DonutSlice[]): ChartConfig {
  const config: ChartConfig = {}
  slices.forEach((slice) => {
    config[slice.name] = {
      label: slice.name,
      color: slice.fill,
    }
  })
  return config
}

// ---------------------------------------------------------------------------
// Per-element click handler types
// ---------------------------------------------------------------------------

/** Shape of the first argument in Recharts Bar onClick callback. */
interface BarClickData {
  payload?: Record<string, unknown>
}

/** Shape of props passed to the activeDot render function on Line / Area. */
interface DotRenderProps {
  cx?: number
  cy?: number
  r?: number
  fill?: string
  stroke?: string
  payload?: Record<string, unknown>
  index?: number
}

// ---------------------------------------------------------------------------
// PlotChart component
// ---------------------------------------------------------------------------

export interface PlotChartProps<T extends BasePlotRecord> {
  data: T[]
  x: string
  y: string
  groupBy: string
  type: PlotSubType
  appearance?: AppearanceConfig
  onSelect?: OnSelectCallback<T>
  className?: string
}

export function PlotChart<T extends BasePlotRecord>({
  data,
  x,
  y,
  groupBy,
  type,
  appearance,
  onSelect,
  className,
}: PlotChartProps<T>) {
  const scheme = appearance?.categoricalScheme
  const overrides = appearance?.colorOverrides
  const curveType: CurveType = appearance?.curveType ?? 'linear'
  const showDots = appearance?.showDots ?? true
  const showGrid = appearance?.showGrid ?? true
  const legendPos = appearance?.legendPosition ?? 'bottom'
  const areaOpacity = appearance?.areaOpacity ?? 0.3
  const barRadius = appearance?.barRadius ?? 4
  const donutInner = appearance?.donutInnerRadius ?? 50
  const includeZero = appearance?.includeZero
  const yMin = appearance?.yMin
  const yMax = appearance?.yMax

  // Formatters (memoised on appearance)
  const formatXAxis = useMemo(
    () => makeFormatXAxis(makeDateFormatter(appearance?.datePrecision)),
    [appearance?.datePrecision],
  )
  const formatValue = useMemo(
    () =>
      makeFormatValue(
        makeNumberFormatter(
          appearance?.decimalPlaces,
          appearance?.compactNumbers,
        ),
      ),
    [appearance?.decimalPlaces, appearance?.compactNumbers],
  )
  const formatSeriesKey = useCallback(
    (seriesKey: string) =>
      groupBy === 'timePoint' ? formatXAxis(seriesKey) : seriesKey,
    [formatXAxis, groupBy],
  )

  // Y-axis domain
  const yDomain = useMemo<
    [number | string, number | string] | undefined
  >(() => {
    if (yMin !== undefined || yMax !== undefined) {
      return [yMin ?? 'auto', yMax ?? 'auto']
    }
    if (includeZero) return [0, 'auto']
    return undefined
  }, [yMin, yMax, includeZero])

  // Pivoted data for cartesian charts (line, area, bar)
  const pivotResult = useMemo(
    () => pivotData(data, x, y, groupBy),
    [data, x, y, groupBy],
  )
  const pivoted = pivotResult.pivoted ?? []
  const seriesKeys = pivotResult.seriesKeys ?? []

  // Donut: 1:1 slices — no aggregation
  const donutSlices = useMemo(
    () =>
      type === 'donut'
        ? prepareDonutSlices(
            data,
            x,
            y,
            groupBy,
            formatXAxis,
            scheme,
            overrides,
          )
        : [],
    [data, x, y, groupBy, type, formatXAxis, scheme, overrides],
  )

  // Grouped data for scatter
  const scatterGroups = useMemo(
    () => (type === 'dot' ? groupBySeries(data, groupBy, x) : []),
    [data, groupBy, type, x],
  )

  // Build dynamic ChartConfig
  const chartConfig = useMemo(() => {
    if (type === 'donut') return buildDonutConfig(donutSlices)
    return buildChartConfig(seriesKeys, scheme, overrides, formatSeriesKey)
  }, [seriesKeys, donutSlices, type, scheme, overrides, formatSeriesKey])

  // Direct color lookup — avoids CSS custom-property indirection entirely
  const colorOf = useCallback(
    (key: string): string => {
      return chartConfig[key]?.color ?? '#000'
    },
    [chartConfig],
  )
  const labelOf = useCallback(
    (key: string): string => {
      const label = chartConfig[key]?.label
      return typeof label === 'string' ? label : formatSeriesKey(key)
    },
    [chartConfig, formatSeriesKey],
  )

  // Legend element (shared across chart types)
  const legendElement =
    legendPos === 'none' ? null : (
      <ChartLegend
        content={
          <ChartLegendContent nameKey={type === 'donut' ? 'name' : undefined} />
        }
        verticalAlign={legendPos}
      />
    )

  // ---------------------------------------------------------------------------
  // Lookup helpers
  // ---------------------------------------------------------------------------

  /**
   * Find an original record matching both the x-value AND the group value.
   * Used by bar / line / area click handlers where multiple series share the
   * same x-position — the series key from the closure disambiguates.
   */
  const findByXAndGroup = useCallback(
    (xValue: unknown, seriesName: string): T | null => {
      const target = String(xValue ?? '')
      return (
        data.find(
          (item) =>
            toStringKey(field(item, x)) === target &&
            toSeriesKey(field(item, groupBy)) === seriesName,
        ) ?? null
      )
    },
    [data, x, groupBy],
  )

  // ---------------------------------------------------------------------------
  // Per-element click factories
  // ---------------------------------------------------------------------------

  /**
   * Returns an onClick handler for a specific `<Bar>` element.
   * The series key is captured via closure so we always know *which* bar was
   * clicked, even when multiple series share the same x-position.
   */
  const makeBarClick = useCallback(
    (seriesKey: string) =>
      (barData: BarClickData, _index: number, event: ReactMouseEvent) => {
        if (!onSelect || !barData.payload) return
        const xValue = field(barData.payload, x)
        const match = findByXAndGroup(xValue, seriesKey)
        onSelect({ dataPoint: match, event })
      },
    [onSelect, findByXAndGroup, x],
  )

  /**
   * Returns a dot render function for a specific `<Line>` or `<Area>`.
   * Used for both `dot` (always visible) and `activeDot` (hover) props.
   * Each rendered circle includes an onClick so every data point is clickable.
   */
  const makeDotRenderer = useCallback(
    (seriesKey: string, radius: number, color: string) =>
      (props: DotRenderProps) => (
        <circle
          cx={props.cx}
          cy={props.cy}
          r={radius}
          fill={color}
          style={{ cursor: onSelect ? 'pointer' : undefined }}
          onClick={(event) => {
            if (!onSelect || !props.payload) return
            const xValue = field(props.payload, x)
            const match = findByXAndGroup(xValue, seriesKey)
            onSelect({ dataPoint: match, event })
          }}
        />
      ),
    [onSelect, findByXAndGroup, x],
  )

  // ---- Error: 1:1 invariant violation ----
  if (pivotResult.error) {
    return (
      <div className="flex h-full min-h-[120px] items-center justify-center rounded-md border border-destructive/50 bg-destructive/5 px-6 py-4 text-center text-sm text-destructive">
        {pivotResult.error}
      </div>
    )
  }

  // ---- Donut (1:1 — each record is its own slice) ----
  if (type === 'donut') {
    return (
      <ChartContainer
        config={chartConfig}
        className={className ?? 'aspect-auto h-full w-full min-h-[240px]'}
      >
        <PieChart>
          <Pie
            data={donutSlices}
            dataKey="value"
            nameKey="name"
            innerRadius={`${donutInner}%`}
            outerRadius="80%"
            paddingAngle={2}
            strokeWidth={0}
            isAnimationActive={false}
            onClick={(
              _entry: Record<string, unknown>,
              index: number,
              event: ReactMouseEvent,
            ) => {
              if (!onSelect) return
              const slice = donutSlices[index]
              if (!slice) return
              const record = data[slice.originalIndex]
              if (record) {
                onSelect({ dataPoint: record, event })
              }
            }}
          >
            {donutSlices.map((slice, i) => (
              <Cell key={i} fill={slice.fill} className="outline-none" />
            ))}
          </Pie>
          {legendElement}
        </PieChart>
      </ChartContainer>
    )
  }

  // ---- Scatter / Dot ----
  if (type === 'dot') {
    return (
      <ChartContainer
        config={chartConfig}
        className={className ?? 'aspect-auto h-full w-full min-h-[240px]'}
      >
        <ScatterChart accessibilityLayer>
          {showGrid && <CartesianGrid strokeDasharray="3 3" />}
          <XAxis
            dataKey={x}
            name={x}
            type="category"
            allowDuplicatedCategory={false}
            tickFormatter={formatXAxis}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          <YAxis
            dataKey={y}
            name={y}
            type="number"
            domain={yDomain}
            tickFormatter={formatValue}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          {legendElement}
          {scatterGroups.map(({ seriesKey, seriesData }) => (
            <Scatter
              key={seriesKey}
              name={labelOf(seriesKey)}
              data={seriesData}
              fill={colorOf(seriesKey)}
              isAnimationActive={false}
              onClick={(
                _point: Record<string, unknown>,
                pointIndex: number,
                event: ReactMouseEvent,
              ) => {
                if (!onSelect) return
                const record = seriesData[pointIndex]
                if (record) {
                  onSelect({ dataPoint: record, event })
                }
              }}
            />
          ))}
        </ScatterChart>
      </ChartContainer>
    )
  }

  // ---- Area / Stacked Area ----
  if (type === 'area' || type === 'stacked-area') {
    const stackId = type === 'stacked-area' ? 'stack' : undefined
    return (
      <ChartContainer
        config={chartConfig}
        className={className ?? 'aspect-auto h-full w-full min-h-[240px]'}
      >
        <AreaChart accessibilityLayer data={pivoted}>
          {showGrid && <CartesianGrid vertical={false} />}
          <XAxis
            dataKey={x}
            tickFormatter={formatXAxis}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          <YAxis
            domain={yDomain}
            tickFormatter={formatValue}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          {legendElement}
          {seriesKeys.map((key) => (
            <Area
              key={key}
              type={curveType}
              dataKey={key}
              stackId={stackId}
              stroke={colorOf(key)}
              fill={colorOf(key)}
              fillOpacity={areaOpacity}
              isAnimationActive={false}
              dot={showDots ? makeDotRenderer(key, 3, colorOf(key)) : false}
              activeDot={
                showDots ? makeDotRenderer(key, 5, colorOf(key)) : false
              }
            />
          ))}
        </AreaChart>
      </ChartContainer>
    )
  }

  // ---- Stacked Bar ----
  if (type === 'stacked-bar') {
    return (
      <ChartContainer
        config={chartConfig}
        className={className ?? 'aspect-auto h-full w-full min-h-[240px]'}
      >
        <BarChart accessibilityLayer data={pivoted}>
          {showGrid && <CartesianGrid vertical={false} />}
          <XAxis
            dataKey={x}
            tickFormatter={formatXAxis}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          <YAxis
            domain={yDomain}
            tickFormatter={formatValue}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          {legendElement}
          {seriesKeys.map((key) => (
            <Bar
              key={key}
              dataKey={key}
              stackId="stack"
              fill={colorOf(key)}
              radius={[0, 0, 0, 0]}
              isAnimationActive={false}
              onClick={makeBarClick(key)}
              style={{ cursor: onSelect ? 'pointer' : undefined }}
            />
          ))}
        </BarChart>
      </ChartContainer>
    )
  }

  // ---- Ranked Bar (horizontal, sorted by value) ----
  if (type === 'ranked-bar') {
    // Build one bar per flat record — bypasses pivotData entirely so that
    // groupBy === x (e.g. both 'timePoint') works correctly.  Each record is
    // one product output → one bar (1:1 invariant).
    const colorIndex = new Map<string, number>()
    const ranked = (data as Record<string, unknown>[])
      .map((item) => {
        const rawKey = toSeriesKey(field(item, groupBy))
        const displayKey = formatSeriesKey(rawKey)
        if (!colorIndex.has(rawKey)) colorIndex.set(rawKey, colorIndex.size)
        const idx = colorIndex.get(rawKey)!
        return {
          name: displayKey,
          rawKey,
          value: numericField(item, y),
          fill: getColor(idx, scheme, overrides, [displayKey, rawKey]),
          _original: item,
        }
      })
      .sort((a, b) => b.value - a.value)

    // Build a config entry per bar so ChartContainer knows the colours.
    const rankedConfig: ChartConfig = Object.fromEntries(
      ranked.map((r) => [r.name, { label: r.name, color: r.fill }]),
    )

    return (
      <ChartContainer
        config={rankedConfig}
        className={className ?? 'aspect-auto h-full w-full min-h-[240px]'}
      >
        <BarChart
          accessibilityLayer
          data={ranked}
          layout="vertical"
          margin={{ right: 60, left: 10 }}
        >
          {showGrid && <CartesianGrid horizontal={false} />}
          <YAxis
            dataKey="name"
            type="category"
            tickLine={false}
            axisLine={false}
            hide
          />
          <XAxis
            dataKey="value"
            type="number"
            tickFormatter={formatValue}
            hide
          />
          <Bar
            dataKey="value"
            layout="vertical"
            radius={barRadius}
            isAnimationActive={false}
            style={{ cursor: onSelect ? 'pointer' : undefined }}
            onClick={(
              barData: BarClickData,
              _index: number,
              event: ReactMouseEvent,
            ) => {
              if (!onSelect) return
              const original = barData.payload?._original
              if (!original) return
              const record = data.find((d) => d === original) ?? null
              onSelect({ dataPoint: record, event })
            }}
          >
            {ranked.map((entry, i) => (
              <Cell key={i} fill={entry.fill} className="outline-none" />
            ))}
            <LabelList
              dataKey="name"
              position="insideLeft"
              offset={8}
              fontSize={12}
              fontWeight={500}
              content={({ x, y, width, height, value, index }) => {
                const barFill =
                  typeof index === 'number' ? ranked[index]?.fill : undefined
                const textFill = barFill
                  ? getContrastingTextColor(barFill)
                  : '#fff'
                const barX = typeof x === 'number' ? x : 0
                const barY = typeof y === 'number' ? y : 0
                const barH = typeof height === 'number' ? height : 0
                const barW = typeof width === 'number' ? width : 0
                // Only show inside label if bar is wide enough
                if (barW < 40) return null
                return (
                  <text
                    x={barX + 8}
                    y={barY + barH / 2}
                    fill={textFill}
                    fontSize={12}
                    fontWeight={500}
                    dominantBaseline="central"
                  >
                    {String(value ?? '')}
                  </text>
                )
              }}
            />
            <LabelList
              dataKey="value"
              position="right"
              offset={8}
              className="fill-foreground"
              fontSize={12}
              formatter={formatValue}
            />
          </Bar>
        </BarChart>
      </ChartContainer>
    )
  }

  // ---- Grouped Bar ----
  if (type === 'grouped-bar') {
    return (
      <ChartContainer
        config={chartConfig}
        className={className ?? 'aspect-auto h-full w-full min-h-[240px]'}
      >
        <BarChart accessibilityLayer data={pivoted}>
          {showGrid && <CartesianGrid vertical={false} />}
          <XAxis
            dataKey={x}
            tickFormatter={formatXAxis}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          <YAxis
            domain={yDomain}
            tickFormatter={formatValue}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          {legendElement}
          {seriesKeys.map((key) => (
            <Bar
              key={key}
              dataKey={key}
              fill={colorOf(key)}
              radius={barRadius}
              isAnimationActive={false}
              onClick={makeBarClick(key)}
              style={{ cursor: onSelect ? 'pointer' : undefined }}
            />
          ))}
        </BarChart>
      </ChartContainer>
    )
  }

  // ---- Line (default) ----
  return (
    <ChartContainer
      config={chartConfig}
      className={className ?? 'aspect-auto h-full w-full min-h-[240px]'}
    >
      <LineChart accessibilityLayer data={pivoted}>
        {showGrid && <CartesianGrid vertical={false} />}
        <XAxis
          dataKey={x}
          tickFormatter={formatXAxis}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
        />
        <YAxis
          domain={yDomain}
          tickFormatter={formatValue}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
        />
        {legendElement}
        {seriesKeys.map((key) => (
          <Line
            key={key}
            type={curveType}
            dataKey={key}
            stroke={colorOf(key)}
            strokeWidth={2}
            isAnimationActive={false}
            dot={showDots ? makeDotRenderer(key, 3, colorOf(key)) : false}
            activeDot={showDots ? makeDotRenderer(key, 5, colorOf(key)) : false}
          />
        ))}
      </LineChart>
    </ChartContainer>
  )
}
