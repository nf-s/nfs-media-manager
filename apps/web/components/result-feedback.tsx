'use client'

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentProps,
  type ComponentPropsWithoutRef,
  type ReactNode,
  type Ref,
} from 'react'
import { Button, type ButtonFeedback } from '@repo/ui/components/ui/button'
import { SortPicker, type SortOption } from '@repo/ui/components/ds/sort-picker'
import { Segmented } from '@repo/ui/components/ds/segmented'
import { ToolbarToggle } from '@repo/ui/components/ds/toolbar'

type Receipt = {
  control: string
  identity: string
  started: boolean
  feedback: ButtonFeedback
}

type Result = { isFetching: boolean; isError: boolean }

type ResultActions = {
  begin: (control: string) => void
  forControl: (control: string) => ButtonFeedback | undefined
}

const ResultContext = createContext<ResultActions>({
  begin: () => {},
  forControl: () => undefined,
})

/** Tracks an explicit change of result set. Polling and virtual scrolling do not start a receipt. */
export function ResultFeedbackScope({
  identity,
  result,
  children,
}: {
  identity: string
  result: Result
  children: ReactNode
}) {
  const [seen, setSeen] = useState(identity)
  const [receipt, setReceipt] = useState<Receipt>()
  if (seen !== identity) {
    setSeen(identity)
    setReceipt({
      control: receipt?.started ? receipt.control : 'filters',
      identity,
      started: false,
      feedback: { phase: 'pending', label: 'Updating…' },
    })
  }
  useEffect(() => {
    if (
      !receipt ||
      receipt.identity !== identity ||
      receipt.started ||
      receipt.feedback.phase !== 'pending' ||
      result.isFetching
    )
      return
    setReceipt({
      ...receipt,
      feedback: result.isError
        ? { phase: 'failed', label: 'Update failed' }
        : { phase: 'done', label: 'Results updated' },
    })
  }, [identity, receipt, result.isFetching, result.isError])
  useEffect(() => {
    // A selected value can resolve to the current query without starting a read.
    if (!receipt || (!receipt.started && receipt.feedback.phase === 'pending'))
      return
    const timeout = window.setTimeout(() => setReceipt(undefined), 4000)
    return () => window.clearTimeout(timeout)
  }, [receipt])
  return (
    <ResultContext.Provider
      value={{
        begin: (control) =>
          setReceipt({
            control,
            identity,
            started: true,
            feedback: { phase: 'pending', label: 'Updating…' },
          }),
        forControl: (control) =>
          receipt?.control === control ? receipt.feedback : undefined,
      }}
    >
      {children}
    </ResultContext.Provider>
  )
}

export function useResultAction(control: string) {
  const context = useContext(ResultContext)
  return {
    begin: () => context.begin(control),
    feedback: context.forControl(control),
  }
}

export function ResultButton({
  control,
  track = true,
  onClick,
  ...props
}: ComponentProps<typeof Button> & { control: string; track?: boolean }) {
  const action = useResultAction(control)
  return (
    <Button
      {...props}
      feedback={action.feedback}
      onClick={(event) => {
        if (track) action.begin()
        onClick?.(event)
      }}
    />
  )
}

export function ResultSortPicker<Key extends string>({
  value,
  options,
  onChange,
}: {
  value: Key
  options: readonly SortOption<Key>[]
  onChange: (key: Key) => void
}) {
  const action = useResultAction('sort-field')
  return (
    <SortPicker
      value={value}
      options={options}
      feedback={action.feedback}
      onChange={(key) => {
        action.begin()
        onChange(key)
      }}
    />
  )
}

/** Panel edits report on their persistent toggle, including when the panel closes. */
export function ResultToolbarToggle({
  control,
  ...props
}: ComponentProps<typeof ToolbarToggle> & { control: string }) {
  const action = useResultAction(control)
  return <ToolbarToggle {...props} feedback={action.feedback} />
}

export function ResultSegmented<Value extends string>({
  label,
  value,
  onChange,
  ...props
}: ComponentProps<typeof Segmented<Value>>) {
  const result = useContext(ResultContext)
  return (
    <Segmented
      {...props}
      label={label}
      value={value}
      feedbackFor={(option) => result.forControl(`${label}-${option}`)}
      onChange={(option) => {
        if (option !== value) result.begin(`${label}-${option}`)
        onChange(option)
      }}
    />
  )
}

export function ResultSection({
  identity,
  result,
  as = 'section',
  ref,
  ...props
}: ComponentPropsWithoutRef<'section'> & {
  identity: string
  result: Result
} & ({ as?: 'section'; ref?: Ref<HTMLElement> } | { as: 'div'; ref?: never })) {
  return (
    <ResultFeedbackScope identity={identity} result={result}>
      {as === 'div' ? <div {...props} /> : <section {...props} ref={ref} />}
    </ResultFeedbackScope>
  )
}
