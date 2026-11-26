'use client'

import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { Button, type ButtonFeedback } from '@repo/ui/components/ui/button'
import { toast } from '@repo/ui/components/ui/sonner'

type Props = Omit<
  ComponentProps<typeof Button>,
  'onClick' | 'feedback' | 'ref'
> & {
  read: () => Promise<unknown>
  loadingLabel?: string
  loadedLabel?: string
}

/** For a disclosure which enables a query only while the user has it open. */
export function openReadFeedback(
  open: boolean,
  pending: boolean,
  failed: boolean,
  loaded: string,
): ButtonFeedback | undefined {
  if (!open) return undefined
  if (pending) return { phase: 'pending', label: 'Loading…' }
  return failed
    ? { phase: 'failed', label: 'Load failed' }
    : { phase: 'done', label: loaded }
}

// Query refetches can resolve with an error result. Bulk retries return one result per page.
function readFailed(result: unknown): boolean {
  if (Array.isArray(result)) return result.some(readFailed)
  return (
    typeof result === 'object' &&
    result !== null &&
    'isError' in result &&
    result.isError === true
  )
}

/** Shows the outcome of this explicit read, independently of background refetches. */
export function ReadButton({
  read,
  loadingLabel = 'Loading…',
  loadedLabel = 'Loaded',
  disabled,
  children,
  ...props
}: Props) {
  const busy = useRef(false)
  const [feedback, setFeedback] = useState<ButtonFeedback>()
  useEffect(() => {
    if (feedback?.phase !== 'done') return
    const timer = window.setTimeout(() => setFeedback(undefined), 4000)
    return () => window.clearTimeout(timer)
  }, [feedback])
  async function run(button: HTMLButtonElement) {
    if (busy.current || disabled) return
    busy.current = true
    setFeedback({ phase: 'pending', label: loadingLabel })
    let outcome: ButtonFeedback
    try {
      const result = await read()
      outcome = readFailed(result)
        ? { phase: 'failed', label: 'Load failed · retry' }
        : { phase: 'done', label: loadedLabel }
    } catch {
      outcome = { phase: 'failed', label: 'Load failed · retry' }
    } finally {
      busy.current = false
    }
    setFeedback(outcome)
    // A successful retry can replace the entire error panel with the result.
    if (outcome.phase === 'done') {
      window.requestAnimationFrame(() => {
        if (!button.isConnected) toast.success(outcome.label)
      })
    }
  }
  return (
    <Button
      type="button"
      {...props}
      disabled={disabled}
      aria-disabled={disabled || feedback?.phase === 'pending' || undefined}
      feedback={feedback}
      onClick={(event) => void run(event.currentTarget)}
    >
      {children}
    </Button>
  )
}
