'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Mic, Search, Square } from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
import {
  AI_AUDIO_MAX_SECONDS,
  AI_SEARCH_MAX_TEXT,
  AiSearchInputSchema,
  AiSearchResponseSchema,
  AiStatusSchema,
  AiTranscriptionInputSchema,
  AiTranscriptionSchema,
  type AiSearchInput,
  type AiSearchPlan,
  type AiSearchResponse,
} from '@repo/schemas/ai-search'
import type { BrowseField } from '@repo/schemas/browse'
import { fetchApiData } from '@/utils/api'
import { encodeRecording } from '@/utils/ai-recording'
import { describeAiSearchPlan } from '@/utils/ai-search'
import { errorMessage } from './lastfm-sync'
import { useConfig } from './providers'
import { useAiMicrophone } from './use-ai-microphone'
import styles from './ai-search.module.css'

type Props = {
  mediaType: 'album' | 'film'
  fields: BrowseField[]
  onApply: (plan: AiSearchPlan) => void
}

export default function AiSearch(props: Props) {
  const [open, setOpen] = useState(false)
  const details = useRef<HTMLDetailsElement>(null)
  return (
    <details
      ref={details}
      className={`toolbar-popover ${styles.popover}`}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <Search size={15} /> AI search
      </summary>
      {open && (
        <AiSearchPanel
          {...props}
          onApply={(plan) => {
            props.onApply(plan)
            if (details.current) details.current.open = false
            setOpen(false)
          }}
        />
      )}
    </details>
  )
}

function AiSearchPanel({ mediaType, fields, onApply }: Props) {
  const { apiBaseUrl } = useConfig()
  const id = useId()
  const [text, setText] = useState('')
  const [result, setResult] = useState<AiSearchResponse | null>(null)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const pending = useRef<{
    controller: AbortController
    timeout: ReturnType<typeof setTimeout>
  } | null>(null)
  const status = useQuery({
    queryKey: ['ai-status'],
    staleTime: 30000,
    retry: false,
    queryFn: ({ signal }) =>
      fetchApiData(apiBaseUrl, '/api/v1/ai/status', AiStatusSchema, { signal }),
  })
  const search = useMutation({
    gcTime: 0,
    retry: false,
    mutationFn: ({
      input,
      signal,
    }: {
      input: AiSearchInput
      signal: AbortSignal
    }) =>
      fetchApiData(apiBaseUrl, '/api/v1/ai/search', AiSearchResponseSchema, {
        method: 'POST',
        body: JSON.stringify(input),
        signal,
      }),
  })
  const transcription = useMutation({
    gcTime: 0,
    retry: false,
    mutationFn: async ({
      audio,
      signal,
    }: {
      audio: Blob
      signal: AbortSignal
    }) => {
      const input = AiTranscriptionInputSchema.parse({
        audio: await encodeRecording(audio),
        mimeType: audio.type,
      })
      if (signal.aborted) throw new Error('Transcription cancelled')
      return fetchApiData(
        apiBaseUrl,
        '/api/v1/ai/transcribe',
        AiTranscriptionSchema,
        {
          method: 'POST',
          body: JSON.stringify(input),
          signal,
        },
      )
    },
  })
  const microphone = useAiMicrophone((audio) => {
    const request = beginRequest()
    transcription.mutate(
      { audio, signal: request.signal },
      {
        onSuccess: (data) => {
          if (request.id !== sequence.current) return
          setText(data.text)
        },
        onError: (failure) => {
          if (request.id !== sequence.current) return
          setError(
            request.signal.aborted
              ? 'Transcription timed out. Try again.'
              : errorMessage(
                  failure,
                  'Could not transcribe the recording. Try again.',
                ),
          )
        },
        onSettled: () => finishRequest(request.id),
      },
    )
  })

  useEffect(
    () => () => {
      sequence.current += 1
      pending.current?.controller.abort()
      clearTimeout(pending.current?.timeout)
    },
    [],
  )

  function cancelRequest() {
    sequence.current += 1
    pending.current?.controller.abort()
    clearTimeout(pending.current?.timeout)
    pending.current = null
    search.reset()
    transcription.reset()
  }

  function beginRequest() {
    cancelRequest()
    setResult(null)
    setError('')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 90000)
    pending.current = { controller, timeout }
    return { id: sequence.current, signal: controller.signal }
  }

  function finishRequest(request: number) {
    if (request !== sequence.current) return
    clearTimeout(pending.current?.timeout)
    pending.current = null
  }

  function submit() {
    const input = AiSearchInputSchema.safeParse({ mediaType, text })
    if (!input.success) {
      setError(`Enter a request of up to ${AI_SEARCH_MAX_TEXT} characters.`)
      return
    }
    const request = beginRequest()
    search.mutate(
      { input: input.data, signal: request.signal },
      {
        onSuccess: (data) => {
          if (request.id === sequence.current) setResult(data)
        },
        onError: (failure) => {
          if (request.id !== sequence.current) return
          setError(
            request.signal.aborted
              ? 'Search timed out. Try again.'
              : errorMessage(
                  failure,
                  'Could not interpret the request. Try again.',
                ),
          )
        },
        onSettled: () => finishRequest(request.id),
      },
    )
  }

  const recording = microphone.phase !== 'idle'
  const working = search.isPending || transcription.isPending
  const available = status.data?.available === true
  const descriptions = result?.plan
    ? describeAiSearchPlan(result.plan, fields)
    : []
  return (
    <div className={`popover-panel ${styles.panel}`}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!working && !recording && available) submit()
        }}
      >
        <label htmlFor={`${id}-text`}>
          Describe the {mediaType === 'album' ? 'albums' : 'films'} to find
        </label>
        <textarea
          id={`${id}-text`}
          value={text}
          maxLength={AI_SEARCH_MAX_TEXT}
          rows={3}
          disabled={recording || transcription.isPending}
          placeholder={
            mediaType === 'album'
              ? 'Rock albums I rarely play with a high RYM rating'
              : 'Unwatched films with a high IMDb rating'
          }
          onChange={(event) => {
            cancelRequest()
            setText(event.target.value)
            setResult(null)
            setError('')
            microphone.clearError()
          }}
        />
        <div className={styles.actions}>
          <Button
            type="button"
            variant="outline"
            className="icon-button"
            aria-label={
              microphone.phase === 'recording'
                ? 'Stop recording'
                : 'Record search'
            }
            title={
              microphone.phase === 'recording'
                ? 'Stop recording'
                : 'Record search'
            }
            disabled={
              !available || working || microphone.phase === 'requesting'
            }
            onClick={() => {
              if (microphone.phase === 'recording') microphone.stop()
              else {
                setResult(null)
                setError('')
                void microphone.start()
              }
            }}
          >
            {microphone.phase === 'recording' ? (
              <Square size={15} />
            ) : (
              <Mic size={15} />
            )}
          </Button>
          {recording && (
            <Button type="button" variant="ghost" onClick={microphone.cancel}>
              Cancel recording
            </Button>
          )}
          {working && (
            <Button type="button" variant="ghost" onClick={cancelRequest}>
              Cancel
            </Button>
          )}
          <Button
            type="submit"
            disabled={!available || working || recording || !text.trim()}
          >
            {search.isPending ? 'Interpreting…' : 'Search'}
          </Button>
        </div>
      </form>
      <div role="status" aria-live="polite">
        {status.isPending && <p>Checking AI availability…</p>}
        {microphone.phase === 'requesting' && (
          <p>Allow microphone access to begin recording.</p>
        )}
        {microphone.phase === 'recording' && (
          <p>Recording · stops after {AI_AUDIO_MAX_SECONDS} seconds.</p>
        )}
        {transcription.isPending && <p>Transcribing…</p>}
      </div>
      {status.isError && (
        <div role="alert">
          <p>Could not check AI availability.</p>
          <Button
            type="button"
            variant="ghost"
            onClick={() => void status.refetch()}
          >
            Retry
          </Button>
        </div>
      )}
      {status.data && !available && (
        <p role="status">{status.data.reason ?? 'AI search is unavailable.'}</p>
      )}
      {(error || microphone.error) && (
        <p role="alert" className={styles.error}>
          {error || microphone.error}
        </p>
      )}
      {result && (
        <div className={styles.result} aria-live="polite">
          <p>{result.explanation}</p>
          {descriptions.length > 0 && (
            <ul aria-label="Proposed filters">
              {descriptions.map((description, index) => (
                <li key={index}>{description}</li>
              ))}
            </ul>
          )}
          {result.assumptions.length > 0 && (
            <div>
              <strong>Assumptions</strong>
              <ul>
                {result.assumptions.map((assumption, index) => (
                  <li key={index}>{assumption}</li>
                ))}
              </ul>
            </div>
          )}
          {result.warnings.length > 0 && (
            <ul aria-label="Data limitations">
              {result.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          )}
          {result.plan && (
            <div className={styles.actions}>
              <Button
                type="button"
                onClick={() => {
                  if (result.plan) onApply(result.plan)
                }}
              >
                Apply filters
              </Button>
              <span className={styles.note}>Replaces current filters.</span>
            </div>
          )}
        </div>
      )}
      <p className={styles.note}>
        Cloudflare processes search text and recordings. Review the
        transcription before searching.
      </p>
    </div>
  )
}
