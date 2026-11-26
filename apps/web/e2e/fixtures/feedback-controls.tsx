import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RefreshCw } from 'lucide-react'
import { Button, type ButtonFeedback } from '@repo/ui/components/ui/button'

const states: ButtonFeedback[] = [
  { phase: 'pending', label: 'Submitting…' },
  { phase: 'queued', label: 'Refresh queued' },
  { phase: 'running', label: 'Fetching page 2 of 10' },
  { phase: 'waiting', label: 'Waiting for the provider' },
  { phase: 'done', label: 'Updated' },
  { phase: 'failed', label: 'Refresh failed · retry' },
  { phase: 'cancelled', label: 'Cancelled' },
  { phase: 'partial', label: 'Saved · refresh failed' },
  { phase: 'unconfirmed', label: 'Refresh unconfirmed' },
]

function controls(feedback?: ButtonFeedback) {
  return renderToStaticMarkup(
    <div className="ds-actions">
      <Button>Previous</Button>
      <Button icon aria-label="Refresh" feedback={feedback}>
        <RefreshCw className="ds-i" aria-hidden />
      </Button>
      <Button size="xs" feedback={feedback}>
        <RefreshCw className="ds-i" aria-hidden />
        Refresh items
      </Button>
      <Button variant="link" feedback={feedback}>
        Retry
      </Button>
      <Button>Next</Button>
    </div>,
  )
}

process.stdout.write(
  JSON.stringify({
    idle: controls(),
    states: states.map((state) => ({ ...state, html: controls(state) })),
  }),
)
