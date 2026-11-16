'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { formatCount } from '../../lib/format'
import {
  axisLabels,
  bucketTrend,
  periodLabel,
  smoothPath,
  sparkValues,
  trendTicks,
  utcDay,
  utcToday,
  type TrendRange,
  type TrendSample,
} from '../../lib/trend'
import { Segmented } from './segmented'

export type TrendDay = { date: string; count: number }
export type TrendMonth = { month: string; count: number }

const RANGES: readonly { value: TrendRange; label: string }[] = [
  { value: '30d', label: '30d' },
  { value: '1y', label: '1y' },
  { value: '5y', label: '5y' },
  { value: 'all', label: 'All' },
]
const MARGIN = { top: 10, right: 6, bottom: 22, left: 32 }
const FIVE_YEARS_MS = 1826 * 86_400_000

/**
 * The one chart for counts over time: a smooth line with a soft fill, no
 * point markers, a crosshair with a tooltip, and ranges of 30 days, 1 year,
 * 5 years and all time. It picks days, weeks, months, quarters or years so
 * the line has enough in each point to read as a line; empty periods are
 * zero and the current, unfinished period is dotted.
 *
 * `days` holds sparse daily counts for the last five years; `months` holds
 * sparse monthly counts for all time and is used when the history is older
 * than `days` can show.
 */
export function TrendChart({
  days,
  months,
  unit = 'scrobbles',
  defaultRange = 'all',
  ranges = RANGES.map((range) => range.value),
  height = 168,
  now,
  extra,
  monthsOnly = false,
}: {
  days: readonly TrendDay[]
  months?: readonly TrendMonth[]
  unit?: string
  defaultRange?: TrendRange
  ranges?: readonly TrendRange[]
  height?: number
  /** Fixed "today" for tests and previews. */
  now?: Date
  /** Controls shown beside the caption, before the range switch. */
  extra?: ReactNode
  /** Only `months` is known: chart months and coarser in every range. */
  monthsOnly?: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(560)
  const [range, setRange] = useState<TrendRange>(defaultRange)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const element = box.current
    if (!element) return
    const measure = () => setWidth(Math.max(240, element.clientWidth))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const today = useMemo(() => utcToday(now), [now])
  const innerWidth = width - MARGIN.left - MARGIN.right
  const innerHeight = height - MARGIN.top - MARGIN.bottom

  const series = useMemo(() => {
    const daily: TrendSample[] = days.map((day) => ({
      t: utcDay(day.date),
      v: day.count,
    }))
    const monthly: TrendSample[] = (months ?? []).map((month) => ({
      t: utcDay(month.month),
      v: month.count,
    }))
    const older =
      monthsOnly ||
      (range === 'all' &&
        monthly.length > 0 &&
        (monthly[0]?.t ?? today) < today - FIVE_YEARS_MS)
    /* No more than one point every 8px, so a narrow chart takes a coarser grain */
    const maxPoints = Math.min(120, Math.max(12, Math.floor(innerWidth / 8)))
    return bucketTrend(older ? monthly : daily, range, {
      today,
      maxPoints,
      finest: older ? 'month' : 'day',
    })
  }, [days, months, monthsOnly, range, today, innerWidth])

  const { grain, points } = series
  const ticks = trendTicks(Math.max(1, ...points.map((point) => point.v)))
  const top = ticks[ticks.length - 1] ?? 1
  const x = (index: number) =>
    Math.round(
      (MARGIN.left +
        (points.length <= 1
          ? innerWidth / 2
          : (index / (points.length - 1)) * innerWidth)) *
        10,
    ) / 10
  const y = (value: number) =>
    Math.round((MARGIN.top + innerHeight - (value / top) * innerHeight) * 10) /
    10
  const coordinates = points.map((point, index): [number, number] => [
    x(index),
    y(point.v),
  ])
  const path = smoothPath(coordinates)
  const partial = grain !== 'day' && path.segments.length > 1
  const solid =
    path.start + (partial ? path.segments.slice(0, -1) : path.segments).join('')
  const first = coordinates[0]
  const last = coordinates[coordinates.length - 1]
  const beforeLast = coordinates[coordinates.length - 2]
  const dashed =
    partial && beforeLast
      ? `M${beforeLast[0]} ${beforeLast[1]}${path.segments[path.segments.length - 1] ?? ''}`
      : ''
  const area =
    first && last
      ? `${path.start}${path.segments.join('')}L${last[0]} ${y(0)}L${first[0]} ${y(0)}Z`
      : ''
  const total = points.reduce((sum, point) => sum + point.v, 0)
  const labels = axisLabels(points, grain, Math.floor(innerWidth / 72))
  const hovered = hover === null ? undefined : points[hover]
  const hoveredAt = hover === null ? undefined : coordinates[hover]

  useEffect(() => {
    const element = tip.current
    if (!element || !hoveredAt) return
    const left = hoveredAt[0]
    element.style.left =
      left > width - 150
        ? `${left - element.offsetWidth - 10}px`
        : `${left + 10}px`
  }, [hoveredAt, width])

  const shownRanges = RANGES.filter((item) => ranges.includes(item.value))

  return (
    <div>
      <div className="ds-charthead">
        <span className="ds-muted ds-chart-caption">
          {unit.charAt(0).toUpperCase()}
          {unit.slice(1)} per {grain}
        </span>
        {extra}
        {shownRanges.length > 1 && (
          <Segmented
            label="Range"
            value={range}
            options={shownRanges}
            onChange={(next) => {
              setHover(null)
              setRange(next)
            }}
          />
        )}
      </div>
      <div className="ds-chart" ref={box}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          height={height}
          role="img"
          aria-label={`${formatCount(total)} ${unit}, by ${grain}`}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                className={tick === 0 ? 'ds-chart-base' : 'ds-chart-grid'}
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text x={MARGIN.left - 8} y={y(tick) + 4} textAnchor="end">
                {formatCount(tick)}
              </text>
            </g>
          ))}
          {labels.map((label) => {
            const at = x(label.index)
            return (
              <text
                key={label.index}
                x={at}
                y={height - 5}
                textAnchor={
                  at < MARGIN.left + 20
                    ? 'start'
                    : at > width - MARGIN.right - 20
                      ? 'end'
                      : 'middle'
                }
              >
                {label.text}
              </text>
            )
          })}
          {area && <path className="ds-chart-area" d={area} />}
          {solid && <path className="ds-chart-line" d={solid} />}
          {dashed && (
            <path className="ds-chart-line" strokeDasharray="1 5" d={dashed} />
          )}
          {hoveredAt && (
            <g>
              <line
                className="ds-chart-cross"
                x1={hoveredAt[0]}
                x2={hoveredAt[0]}
                y1={MARGIN.top}
                y2={y(0)}
              />
              <circle
                className="ds-chart-dot"
                r={4}
                cx={hoveredAt[0]}
                cy={hoveredAt[1]}
              />
            </g>
          )}
          <rect
            x={MARGIN.left}
            y={0}
            width={Math.max(0, innerWidth)}
            height={height}
            fill="transparent"
            onPointerMove={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect()
              if (!points.length || bounds.width === 0) return
              const index = Math.round(
                ((event.clientX - bounds.left) / bounds.width) *
                  (points.length - 1),
              )
              setHover(Math.max(0, Math.min(points.length - 1, index)))
            }}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
        <div className="ds-chart-tip" ref={tip} hidden={!hovered}>
          {hovered && hover !== null && (
            <>
              <b>
                {formatCount(hovered.v)} {unit}
              </b>
              <span>
                {periodLabel(hovered.t, grain, hover === points.length - 1)}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** A 72×20 trend with no axes: at most 16 points, merged from `values`. */
export function Sparkline({
  values,
  width = 72,
  height = 20,
  label,
}: {
  values: readonly number[]
  width?: number
  height?: number
  label?: string
}) {
  const merged = sparkValues(values)
  if (merged.length < 2) return null
  const max = Math.max(1, ...merged)
  const coordinates = merged.map((value, index): [number, number] => [
    Math.round((index / (merged.length - 1)) * width * 10) / 10,
    Math.round((height - 2 - (value / max) * (height - 4)) * 10) / 10,
  ])
  const path = smoothPath(coordinates)
  const line = path.start + path.segments.join('')
  return (
    <svg
      className="ds-spark"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path data-area="" d={`${line}L${width} ${height}L0 ${height}Z`} />
      <path d={line} />
    </svg>
  )
}
