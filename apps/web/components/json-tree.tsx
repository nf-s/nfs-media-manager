'use client'

import React, { useState } from 'react'
import type { JsonValue } from '@repo/schemas/common'

const PAGE_SIZE = 50

function JsonNode({
  value,
  label,
  initiallyOpen = false,
}: {
  value: JsonValue
  label?: string
  initiallyOpen?: boolean
}) {
  const [open, setOpen] = useState(initiallyOpen)
  const [visible, setVisible] = useState(PAGE_SIZE)
  const prefix = label === undefined ? '' : `${JSON.stringify(label)}: `

  if (value === null || typeof value !== 'object') {
    const color =
      typeof value === 'string'
        ? 'text-emerald-700'
        : typeof value === 'number'
          ? 'text-blue-700'
          : 'text-amber-800'
    return (
      <div className="break-words py-0.5 [overflow-wrap:anywhere]">
        {prefix}
        <span className={color}>{JSON.stringify(value)}</span>
      </div>
    )
  }

  const array = Array.isArray(value)
  const keys = Object.keys(value)
  const count = keys.length
  const entries = open
    ? keys.slice(0, visible).flatMap((key) => {
        const child = array ? value[Number(key)] : value[key]
        return child === undefined ? [] : [{ key, value: child }]
      })
    : []

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        className="break-words py-0.5 [overflow-wrap:anywhere]"
        style={{ display: 'list-item', fontSize: 'inherit' }}
      >
        {prefix}
        <span className="text-neutral-500">
          {array ? '[' : '{'} {count} {array ? 'items' : 'keys'}{' '}
          {array ? ']' : '}'}
        </span>
      </summary>
      {open && (
        <div className="ml-3 border-l border-neutral-200 pl-3">
          {entries.map((entry) => (
            <JsonNode key={entry.key} label={entry.key} value={entry.value} />
          ))}
          {count > visible && (
            <button
              type="button"
              className="py-1 text-blue-700 underline underline-offset-2"
              onClick={() => setVisible((current) => current + PAGE_SIZE)}
            >
              Show {Math.min(PAGE_SIZE, count - visible)} more (
              {count - visible} remaining)
            </button>
          )}
        </div>
      )}
    </details>
  )
}

export default function JsonTree({ value }: { value: JsonValue }) {
  const [rawOpen, setRawOpen] = useState(false)
  return (
    <div className="min-w-0 space-y-2 py-2">
      <div className="max-h-[60vh] overflow-auto px-4 font-mono text-xs leading-5">
        <JsonNode value={value} initiallyOpen />
      </div>
      <details
        open={rawOpen}
        onToggle={(event) => setRawOpen(event.currentTarget.open)}
      >
        <summary
          className="text-xs text-neutral-500"
          style={{ display: 'list-item' }}
        >
          Raw JSON
        </summary>
        {rawOpen && <pre>{JSON.stringify(value, null, 2)}</pre>}
      </details>
    </div>
  )
}
