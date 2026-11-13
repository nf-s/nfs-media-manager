'use client'

import { useEffect, useRef, useState, type PointerEvent } from 'react'
import {
  barLayout,
  chartPoints,
  LABEL_CHAR_WIDTH,
  periodAt,
  periodScrobbles,
  steppedPeriod,
  xLabelIndices,
  yTicks,
  type ListeningBar,
  type ListeningChartStyle,
  type ListeningPeriod,
  type PlotArea,
} from '@/utils/listening-chart'

const DEFAULT_WIDTH = 640
const HEIGHT = 192
const TOP = 8
const BOTTOM = 20
const MAX_MARKERS = 40
const Y_LABEL_GAP = 6

function useContainerWidth() {
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  useEffect(() => {
    const element = container.current
    if (!element) return
    const update = () => {
      if (element.clientWidth > 0) setWidth(element.clientWidth)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return { container, width }
}

export function ListeningChart({
  bars,
  period,
  style,
}: {
  bars: ListeningBar[]
  period: ListeningPeriod
  style: ListeningChartStyle
}) {
  const { container, width } = useContainerWidth()
  const [active, setActive] = useState<number | null>(null)
  const [activePeriod, setActivePeriod] = useState(period)
  if (activePeriod !== period) {
    setActivePeriod(period)
    setActive(null)
  }
  const ticks = yTicks(Math.max(0, ...bars.map((bar) => bar.count)))
  const yMax = ticks.at(-1) ?? 1
  const yLabelWidth =
    Math.max(...ticks.map((tick) => tick.toLocaleString().length)) *
    LABEL_CHAR_WIDTH
  const left = Math.ceil(yLabelWidth) + Y_LABEL_GAP
  const plot: PlotArea = {
    left,
    top: TOP,
    width: Math.max(1, width - left),
    height: HEIGHT - TOP - BOTTOM,
  }
  const baseline = plot.top + plot.height
  const { slot, barWidth } = barLayout(bars.length, plot.width)
  const points = chartPoints(
    bars.map((bar) => bar.count),
    yMax,
    plot,
    style,
  )
  const labels = xLabelIndices(bars, period, plot.width)
  const activeBar = active === null ? undefined : bars[active]
  const activePoint = active === null ? undefined : points[active]
  const line = points.map((point) => `${point.x},${point.y}`).join(' ')
  const firstPoint = points[0]
  const lastPoint = points.at(-1)
  const area =
    firstPoint && lastPoint
      ? `${firstPoint.x},${baseline} ${line} ${lastPoint.x},${baseline}`
      : ''

  const pointTo = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (!rect.width) return
    const x = ((event.clientX - rect.left) * width) / rect.width
    setActive(periodAt(x, bars.length, plot, style))
  }

  return (
    <div
      ref={container}
      className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
      tabIndex={0}
      role="group"
      aria-label={
        period === 'year' ? 'Scrobbles by year' : 'Scrobbles by month'
      }
      onKeyDown={(event) => {
        const next = steppedPeriod(active, event.key, bars.length)
        if (next === null) return
        event.preventDefault()
        setActive(next)
      }}
      onFocus={() => setActive((current) => current ?? bars.length - 1)}
      onBlur={() => setActive(null)}
    >
      <svg
        aria-hidden="true"
        className="block w-full touch-pan-y select-none"
        viewBox={`0 0 ${width} ${HEIGHT}`}
        height={HEIGHT}
        preserveAspectRatio="none"
        onPointerMove={pointTo}
        onPointerDown={pointTo}
        onPointerLeave={() => setActive(null)}
      >
        {style === 'bar' && activePoint && (
          <rect
            x={activePoint.x - slot / 2}
            y={plot.top}
            width={slot}
            height={plot.height}
            className="fill-slate-100"
          />
        )}
        {ticks.map((tick) => {
          const y = plot.top + plot.height * (1 - tick / yMax)
          return (
            <g key={tick}>
              <line
                x1={plot.left}
                x2={plot.left + plot.width}
                y1={y}
                y2={y}
                className={tick === 0 ? 'stroke-slate-300' : 'stroke-slate-200'}
                shapeRendering="crispEdges"
              />
              <text
                x={plot.left - Y_LABEL_GAP}
                y={y}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-slate-600 text-[11px] tabular-nums"
              >
                {tick.toLocaleString()}
              </text>
            </g>
          )
        })}
        {labels.map((index) => {
          const bar = bars[index]
          const point = points[index]
          if (!bar || !point) return null
          // A label at either end of the line stays inside the plot.
          const half = (bar.year.length * LABEL_CHAR_WIDTH) / 2
          const anchor =
            point.x - half < plot.left
              ? 'start'
              : point.x + half > width
                ? 'end'
                : 'middle'
          return (
            <text
              key={bar.period}
              x={point.x}
              y={baseline + 14}
              textAnchor={anchor}
              className="fill-slate-600 text-[11px] tabular-nums"
            >
              {bar.year}
            </text>
          )
        })}
        {style === 'bar' &&
          bars.map((bar, index) => {
            const point = points[index]
            if (!point || bar.count === 0) return null
            return (
              <rect
                key={bar.period}
                x={point.x - barWidth / 2}
                y={point.y}
                width={barWidth}
                height={baseline - point.y}
                className={
                  index === active ? 'fill-slate-800' : 'fill-slate-500'
                }
                shapeRendering={slot < 4 ? 'crispEdges' : undefined}
              />
            )
          })}
        {style === 'line' && (
          <>
            <polygon points={area} className="fill-slate-500/15" />
            <polyline
              points={line}
              fill="none"
              strokeWidth={1.5}
              strokeLinejoin="round"
              className="stroke-slate-600"
            />
            {activePoint && (
              <line
                x1={activePoint.x}
                x2={activePoint.x}
                y1={plot.top}
                y2={baseline}
                className="stroke-slate-400"
                shapeRendering="crispEdges"
              />
            )}
            {points.map((point, index) =>
              bars.length <= MAX_MARKERS || index === active ? (
                <circle
                  key={bars[index]?.period ?? index}
                  cx={point.x}
                  cy={point.y}
                  r={index === active ? 4 : 2.5}
                  className={
                    index === active
                      ? 'fill-slate-800'
                      : 'fill-white stroke-slate-600'
                  }
                  strokeWidth={1.5}
                />
              ) : null,
            )}
          </>
        )}
      </svg>
      <p aria-live="polite" className="h-5 text-sm tabular-nums text-slate-600">
        {activeBar ? periodScrobbles(activeBar) : ''}
      </p>
      <ul className="sr-only">
        {bars.map((bar) => (
          <li key={bar.period}>{periodScrobbles(bar)}</li>
        ))}
      </ul>
    </div>
  )
}
