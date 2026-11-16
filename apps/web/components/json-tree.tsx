'use client'

import React, { useState } from 'react'
import type { JsonValue } from '@repo/schemas/common'
import { Button } from '@repo/ui/components/ui/button'

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
    const kind =
      typeof value === 'string'
        ? 'string'
        : typeof value === 'number'
          ? 'number'
          : 'literal'
    return (
      <div className="ops-json-line">
        {prefix}
        <span className="ops-json-value" data-kind={kind}>
          {JSON.stringify(value)}
        </span>
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
      <summary className="ops-json-line">
        {prefix}
        <span className="ds-muted">
          {array ? '[' : '{'} {count} {array ? 'items' : 'keys'}{' '}
          {array ? ']' : '}'}
        </span>
      </summary>
      {open && (
        <div className="ops-json-children">
          {entries.map((entry) => (
            <JsonNode key={entry.key} label={entry.key} value={entry.value} />
          ))}
          {count > visible && (
            <Button
              variant="link"
              size="xs"
              onClick={() => setVisible((current) => current + PAGE_SIZE)}
            >
              Show {Math.min(PAGE_SIZE, count - visible)} more (
              {count - visible} remaining)
            </Button>
          )}
        </div>
      )}
    </details>
  )
}

export default function JsonTree({ value }: { value: JsonValue }) {
  const [rawOpen, setRawOpen] = useState(false)
  return (
    <div className="ops-json">
      <div className="ops-json-body">
        <JsonNode value={value} initiallyOpen />
      </div>
      <details
        className="ops-disclosure"
        open={rawOpen}
        onToggle={(event) => setRawOpen(event.currentTarget.open)}
      >
        <summary>Raw JSON</summary>
        {rawOpen && (
          <pre className="ops-pre">{JSON.stringify(value, null, 2)}</pre>
        )}
      </details>
    </div>
  )
}
