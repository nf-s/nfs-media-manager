'use client'

import { useState } from 'react'

const adjustmentKeys = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

/** Keep a gesture local until it ends, so moving the slider triggers one results query. */
export function RatingWeightControl({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (value: number) => void
}) {
  const [adjustment, setAdjustment] = useState<{
    input: number | 'keyboard'
    initial: number
    draft: number | null
  } | null>(null)

  // Discard the rest of an in-flight gesture if the parent replaces its value.
  if (adjustment && adjustment.draft !== null && adjustment.initial !== value)
    setAdjustment({ ...adjustment, draft: null })

  const shown = adjustment?.draft ?? value
  function finish() {
    setAdjustment(null)
    if (shown !== value) onChange(shown)
  }

  return (
    <label className="ds-rating-weight">
      {label}
      <input
        type="range"
        min={0}
        max={3}
        step={0.5}
        value={shown}
        aria-label={label}
        aria-valuetext={`${shown}×`}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          setAdjustment({
            input: event.pointerId,
            initial: value,
            draft: value,
          })
        }}
        onPointerUp={(event) => {
          if (adjustment?.input === event.pointerId) finish()
        }}
        onLostPointerCapture={(event) => {
          if (adjustment?.input === event.pointerId) setAdjustment(null)
        }}
        onPointerCancel={() => setAdjustment(null)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && adjustment) {
            setAdjustment({ ...adjustment, draft: null })
          } else if (!adjustment && adjustmentKeys.has(event.key)) {
            setAdjustment({ input: 'keyboard', initial: value, draft: value })
          }
        }}
        onKeyUp={(event) => {
          if (adjustment?.input === 'keyboard' && adjustmentKeys.has(event.key))
            finish()
        }}
        onBlur={() => {
          if (adjustment?.input === 'keyboard') finish()
          else setAdjustment(null)
        }}
        onChange={(event) => {
          const next = event.currentTarget.valueAsNumber
          if (adjustment) {
            if (adjustment.draft !== null)
              setAdjustment({ ...adjustment, draft: next })
          } else if (next !== value) {
            // Assistive technology can adjust the value without a pointer or key event.
            onChange(next)
          }
        }}
      />
      <span className="ds-num" aria-hidden="true">
        {shown}×
      </span>
    </label>
  )
}

export function RatingDifference({
  value,
  difference,
  label,
  onClick,
}: {
  value: string
  difference: number | null
  label: string
  onClick: () => void
}) {
  const text =
    difference === null
      ? value
      : `${value} (${difference > 0 ? '+' : ''}${difference.toFixed(1)})`
  return (
    <button
      type="button"
      className="ds-rating-difference"
      data-direction={
        difference !== null && Math.abs(difference) >= 20
          ? difference > 0
            ? 'high'
            : 'low'
          : undefined
      }
      aria-label={`${label}, ${text}`}
      onClick={onClick}
    >
      {text}
    </button>
  )
}

/** Place the counted sources and their combined score on the same 100-point scale. */
export function RatingPositionStrip({
  values,
  score,
}: {
  values: readonly number[]
  score: number | null
}) {
  if (score === null) return null
  const label = `Source ratings ${values.map((value) => value.toFixed(1)).join(', ')}. Combined score ${score.toFixed(1)} out of 100.`
  return (
    <span
      className="ds-rating-position"
      role="img"
      aria-label={label}
      title={label}
    >
      {values.map((value, index) => (
        <i key={index} style={{ left: `${value}%` }} />
      ))}
      <i data-score="" style={{ left: `${score}%` }} />
    </span>
  )
}
