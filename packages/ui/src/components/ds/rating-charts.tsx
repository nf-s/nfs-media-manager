'use client'

import { Fragment, useEffect, useId, useRef, useState } from 'react'
import { EMPTY_VALUE, formatCount } from '../../lib/format'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui/components/ui/table'

export type RatingAxis = { key: string; label: string; shortLabel?: string }
type Pair = { x: string; y: string; count: number; correlation: number | null }

/** The row supplies the horizontal axis and the column supplies the vertical axis. */
export function RatingAgreementMatrix({
  sources,
  pairs,
  onCompare,
}: {
  sources: readonly RatingAxis[]
  pairs: readonly Pair[]
  onCompare: (axes: { x: string; y: string }) => void
}) {
  const byPair = new Map<string, Pair>()
  for (const pair of pairs) {
    byPair.set(pair.x + ':' + pair.y, pair)
    byPair.set(pair.y + ':' + pair.x, pair)
  }
  return (
    <Table className="ds-rating-matrix" aria-label="Source agreement">
      <TableHeader>
        <TableRow>
          <TableHead sticky={0} aria-label="Source" />
          {sources.map((source) => (
            <TableHead key={source.key} title={source.label}>
              <span>{source.shortLabel ?? source.label}</span>
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sources.map((row) => (
          <TableRow key={row.key}>
            <TableHead scope="row" sticky={0} title={row.label}>
              <span>{row.shortLabel ?? row.label}</span>
            </TableHead>
            {sources.map((column) => {
              const pair = byPair.get(row.key + ':' + column.key)
              const value = pair?.correlation
              if (row.key === column.key)
                return (
                  <TableCell key={column.key}>
                    <span className="ds-rating-self" aria-label="Same source" />
                  </TableCell>
                )
              if (!pair || value == null) {
                const reason =
                  pair && pair.count >= 20
                    ? 'The overlapping ratings have no variation.'
                    : 'Fewer than 20 items have both ratings.'
                return (
                  <TableCell key={column.key} title={reason}>
                    <span aria-label={reason}>{EMPTY_VALUE}</span>
                  </TableCell>
                )
              }
              const description =
                row.label +
                ' and ' +
                column.label +
                ': ' +
                value.toFixed(2) +
                ' across ' +
                formatCount(pair.count) +
                ' items'
              return (
                <TableCell key={column.key}>
                  <button
                    type="button"
                    className="ds-rating-pair"
                    data-negative={value < 0 || undefined}
                    data-strong={value > 0.55 || undefined}
                    style={
                      value < 0
                        ? undefined
                        : {
                            backgroundColor:
                              'color-mix(in srgb, var(--ds-accent) ' +
                              100 * value +
                              '%, var(--ds-surface))',
                          }
                    }
                    title={description}
                    aria-label={description + '. Compare'}
                    onClick={() => onCompare({ x: row.key, y: column.key })}
                  >
                    {(value < 0 ? '−' : '') +
                      Math.abs(value).toFixed(2).replace(/^0/, '')}
                  </button>
                </TableCell>
              )
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function RatingBiasBar({
  value,
  maximum,
  diverging = false,
  label,
}: {
  value: number
  maximum: number
  diverging?: boolean
  label: string
}) {
  const width = (Math.abs(value) / maximum) * (diverging ? 50 : 100)
  return (
    <span className="ds-rating-bias">
      <span
        className="ds-rating-bar"
        data-diverging={diverging || undefined}
        aria-hidden="true"
      >
        <i
          style={{
            width: width + '%',
            ...(diverging && value < 0
              ? { right: '50%' }
              : { left: diverging ? '50%' : 0 }),
          }}
        />
      </span>
      <span className="ds-num">{label}</span>
    </span>
  )
}

type Point = { id: string; title: string; x: number; y: number }
export type RatingPlotAxis = RatingAxis & {
  min: number | null
  max: number | null
}
function domain(axis: RatingPlotAxis): [number, number] {
  if (axis.key !== 'year' && axis.key !== 'spread') return [0, 100]
  if (axis.min === null || axis.max === null) return [0, 1]
  return axis.key === 'year'
    ? [Math.floor(axis.min / 10) * 10, Math.ceil((axis.max + 1) / 10) * 10]
    : [0, Math.max(10, Math.ceil(axis.max / 10) * 10)]
}
function ticks([lo, hi]: [number, number]) {
  const span = hi - lo
  const step =
    span <= 50
      ? 10
      : span <= 120
        ? 25
        : Math.max(50, Math.ceil(span / 5 / 50) * 50)
  const values: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) values.push(v)
  return values
}

/** One tab stop for a plot, including coincident points. Arrow keys move the selection. */
export function RatingScatter({
  x,
  y,
  bothRated,
  points,
  selected,
  onSelect,
  onOpen,
}: {
  x: RatingPlotAxis
  y: RatingPlotAxis
  bothRated: boolean
  points: readonly Point[]
  selected: string | null
  onSelect: (id: string | null) => void
  onOpen: (id: string) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const id = useId()
  const [width, setWidth] = useState(340)
  useEffect(() => {
    const node = container.current
    if (!node) return
    const resize = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0)
        setWidth(Math.max(180, entry.contentRect.width))
    })
    resize.observe(node)
    return () => resize.disconnect()
  }, [])
  const height = Math.min(width, 460)
  const left = y.key === 'year' ? 48 : 38,
    right = width - 14,
    top = 12,
    bottom = height - 38
  const dx = domain(x),
    dy = domain(y)
  const sx = (value: number) =>
    left + ((value - dx[0]) / (dx[1] - dx[0])) * (right - left)
  const sy = (value: number) =>
    bottom - ((value - dy[0]) / (dy[1] - dy[0])) * (bottom - top)
  const active = points.findIndex((p) => p.id === selected)
  return (
    <div className="ds-rating-scatter" ref={container}>
      <svg
        viewBox={'0 0 ' + width + ' ' + height}
        role="listbox"
        tabIndex={0}
        aria-label={
          y.label +
          ' against ' +
          x.label +
          ', ' +
          formatCount(points.length) +
          ' plotted items'
        }
        aria-describedby={id + '-help'}
        aria-activedescendant={active >= 0 ? id + '-' + active : undefined}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          if (!rect.width || !rect.height) return
          const px = ((event.clientX - rect.left) * width) / rect.width,
            py = ((event.clientY - rect.top) * height) / rect.height
          let distance = 24 ** 2,
            nearest: string | null = null
          for (const p of points) {
            const next = (sx(p.x) - px) ** 2 + (sy(p.y) - py) ** 2
            if (next < distance) {
              distance = next
              nearest = p.id
            }
          }
          onSelect(nearest)
        }}
        onKeyDown={(event) => {
          if (!points.length) return
          let next = active
          switch (event.key) {
            case 'ArrowRight':
            case 'ArrowDown':
              next = Math.min(points.length - 1, active + 1)
              break
            case 'ArrowLeft':
            case 'ArrowUp':
              next = Math.max(0, active - 1)
              break
            case 'Home':
              next = 0
              break
            case 'End':
              next = points.length - 1
              break
            case 'Enter':
              if (selected) onOpen(selected)
              break
            case 'Escape':
              onSelect(null)
              break
            default:
              return
          }
          event.preventDefault()
          if (next !== active) onSelect(points[next]?.id ?? null)
        }}
      >
        <g aria-hidden="true">
          {ticks(dx).map((v) => (
            <Fragment key={v}>
              <line x1={sx(v)} x2={sx(v)} y1={top} y2={bottom} />
              <text x={sx(v)} y={bottom + 14} textAnchor="middle">
                {v}
              </text>
            </Fragment>
          ))}
          {ticks(dy).map((v) => (
            <Fragment key={v}>
              <line x1={left} x2={right} y1={sy(v)} y2={sy(v)} />
              <text x={left - 6} y={sy(v) + 4} textAnchor="end">
                {v}
              </text>
            </Fragment>
          ))}
          <path
            className="ds-rating-axis"
            d={`M ${left} ${top} V ${bottom} H ${right}`}
          />
          {bothRated && (
            <line
              className="ds-rating-diagonal"
              x1={sx(0)}
              y1={sy(0)}
              x2={sx(100)}
              y2={sy(100)}
            />
          )}
          <text x={(left + right) / 2} y={height - 4} textAnchor="middle">
            {x.label}
          </text>
          <text
            transform={`translate(11 ${(bottom + top) / 2}) rotate(-90)`}
            textAnchor="middle"
          >
            {y.label}
          </text>
        </g>
        {points.map((p, i) => (
          <circle
            key={p.id}
            id={id + '-' + i}
            role="option"
            aria-selected={i === active}
            aria-label={
              p.title +
              ', ' +
              x.label +
              ' ' +
              Math.round(p.x) +
              ', ' +
              y.label +
              ' ' +
              Math.round(p.y)
            }
            cx={sx(p.x)}
            cy={sy(p.y)}
            data-direction={
              bothRated && Math.abs(p.y - p.x) >= 20
                ? p.y > p.x
                  ? 'high'
                  : 'low'
                : undefined
            }
          />
        ))}
        {active >= 0 && points[active] && (
          <circle
            className="ds-rating-selected"
            aria-hidden="true"
            cx={sx(points[active].x)}
            cy={sy(points[active].y)}
          />
        )}
      </svg>
      <span className="sr-only" id={id + '-help'}>
        Use the arrow keys to pick an item. Press Enter to open its calculation.
      </span>
    </div>
  )
}
