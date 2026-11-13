'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Eye, LoaderCircle, Mic, Square, X } from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
import {
  AI_AUDIO_MAX_SECONDS,
  AI_SEARCH_MAX_TEXT,
  AiSearchInputSchema,
  AiStatusSchema,
  AiTranscriptionInputSchema,
  AiTranscriptionSchema,
  type AiSearchInput,
} from '@repo/schemas/ai-search'
import { fetchApiData } from '@/utils/api'
import { encodeRecording } from '@/utils/ai-recording'
import type { AiSearchResult, AiSearchTarget } from '@/utils/ai-search'
import { errorMessage } from './lastfm-sync'
import { useConfig } from './providers'
import { useAiMicrophone } from './use-ai-microphone'
import BrowseFilterAutocomplete, {
  type BrowseFilterAutocompleteProps,
} from './browse-filter-autocomplete'
import styles from './ai-search.module.css'

type Props<Plan> = {
  target: AiSearchTarget<Plan>
  queryIdentity: string
  autocomplete: BrowseFilterAutocompleteProps
  onApply: (plan: Plan) => void
}

export default function AiSearch<Plan>({
  target,
  queryIdentity,
  autocomplete,
  onApply,
}: Props<Plan>) {
  const { apiBaseUrl } = useConfig()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [submittedText, setSubmittedText] = useState('')
  const [result, setResult] = useState<AiSearchResult<Plan> | null>(null)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const currentQuery = useRef(queryIdentity)
  currentQuery.current = queryIdentity
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
      fetchApiData(apiBaseUrl, '/api/v1/ai/search', target.responseSchema, {
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
          if (!isCurrentRequest(request)) return
          autocomplete.onValueChange(data.text)
          submit(data.text)
        },
        onError: (failure) => {
          if (!isCurrentRequest(request)) return
          setOpen(true)
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
    setError('')
    setOpen(false)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 90000)
    pending.current = { controller, timeout }
    return { id: sequence.current, signal: controller.signal, queryIdentity }
  }

  function isCurrentRequest(request: ReturnType<typeof beginRequest>) {
    return (
      request.id === sequence.current &&
      request.queryIdentity === currentQuery.current
    )
  }

  useEffect(() => {
    cancelRequest()
    microphone.cancel()
  }, [queryIdentity])

  function finishRequest(request: number) {
    if (request !== sequence.current) return
    clearTimeout(pending.current?.timeout)
    pending.current = null
  }

  function submit(text: string) {
    if (!status.data?.available) {
      setOpen(true)
      return
    }
    const input = AiSearchInputSchema.safeParse({
      mediaType: target.mediaType,
      text,
    })
    if (!input.success) {
      setError(`Enter a request of up to ${AI_SEARCH_MAX_TEXT} characters.`)
      setOpen(true)
      return
    }
    const request = beginRequest()
    search.mutate(
      { input: input.data, signal: request.signal },
      {
        onSuccess: (data) => {
          if (!isCurrentRequest(request)) return
          setResult(data)
          setSubmittedText(input.data.text)
          if (data.plan) onApply(data.plan)
          setOpen(!data.plan || data.warnings.length > 0)
        },
        onError: (failure) => {
          if (!isCurrentRequest(request)) return
          setOpen(true)
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

  useEffect(() => {
    if (microphone.error) setOpen(true)
  }, [microphone.error])

  const recording = microphone.phase !== 'idle'
  const working = search.isPending || transcription.isPending
  const available = status.data?.available === true
  const descriptions = result?.plan ? target.describe(result.plan) : []
  const hasDetails = Boolean(
    result || error || microphone.error || (!status.isPending && !available),
  )
  const activity =
    microphone.phase === 'requesting'
      ? 'Allow microphone access…'
      : microphone.phase === 'recording'
        ? 'Dictating…'
        : transcription.isPending
          ? 'Transcribing…'
          : search.isPending
            ? 'Interpreting…'
            : ''

  function cancel() {
    cancelRequest()
    microphone.cancel()
    setOpen(false)
  }

  return (
    <BrowseFilterAutocomplete
      {...autocomplete}
      value={
        recording || transcription.isPending ? activity : autocomplete.value
      }
      disabled={recording || transcription.isPending}
      hideSuggestions={open || recording || working}
      onFocus={() => setOpen(false)}
      onValueChange={(value) => {
        cancelRequest()
        setError('')
        microphone.clearError()
        setOpen(false)
        autocomplete.onValueChange(value)
      }}
      onAiSearch={submit}
      aiSearchDisabled={recording || working || status.isPending}
      inputActions={
        <>
          {working || microphone.phase === 'requesting' ? (
            <LoaderCircle
              size={15}
              className={styles.spinner}
              aria-hidden="true"
            />
          ) : (
            <Button
              type="button"
              variant="ghost"
              className="icon-button"
              aria-label={
                recording ? 'Stop recording and search' : 'Record search'
              }
              title={recording ? 'Stop recording and search' : 'Record search'}
              disabled={status.isPending}
              onClick={() => {
                if (recording) microphone.stop()
                else if (!available) setOpen(true)
                else {
                  setOpen(false)
                  setError('')
                  void microphone.start()
                }
              }}
            >
              {recording ? <Square size={14} /> : <Mic size={15} />}
            </Button>
          )}
          {recording || working ? (
            <Button
              type="button"
              variant="ghost"
              className="icon-button"
              aria-label={recording ? 'Cancel recording' : 'Cancel AI search'}
              title={recording ? 'Cancel recording' : 'Cancel AI search'}
              onClick={cancel}
            >
              <X size={15} />
            </Button>
          ) : hasDetails ? (
            <details
              open={open}
              className={`toolbar-popover ${styles.popover}`}
              onToggle={(event) => setOpen(event.currentTarget.open)}
            >
              <summary
                aria-label="Show AI search interpretation"
                title="Show AI search interpretation"
                aria-controls={`${id}-interpretation`}
              >
                <Eye size={15} />
              </summary>
              <div
                id={`${id}-interpretation`}
                className={`popover-panel ${styles.panel}`}
                role="region"
                aria-label="AI search interpretation"
              >
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
                  <p role="status">
                    {status.data.reason ?? 'AI search is unavailable.'}
                  </p>
                )}
                {(error || microphone.error) && (
                  <p role="alert" className={styles.error}>
                    {error || microphone.error}
                  </p>
                )}
                {result && (
                  <div className={styles.result}>
                    <div>
                      <strong>Request</strong>
                      <p>{submittedText}</p>
                    </div>
                    <p>{result.explanation}</p>
                    {descriptions.length > 0 && (
                      <ul aria-label="Interpreted filters">
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
                  </div>
                )}
                <p className={styles.note}>
                  Cloudflare processes search text and recordings.
                </p>
              </div>
            </details>
          ) : null}
        </>
      }
    >
      <span role="status" className="sr-only">
        {microphone.phase === 'recording'
          ? `Dictating. Stops after ${AI_AUDIO_MAX_SECONDS} seconds.`
          : activity ||
            (result?.plan
              ? 'AI search applied. Use the eye icon to review its interpretation.'
              : '')}
      </span>
    </BrowseFilterAutocomplete>
  )
}
