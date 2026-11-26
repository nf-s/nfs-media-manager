'use client'

import { useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import type { ProviderSummary } from '@repo/schemas/provider'
import type { Job } from '@repo/schemas/job'
import {
  AlbumDetailSchema,
  FilmDetailSchema,
  type AlbumDetail,
  type FilmDetail,
} from '@repo/schemas/media'
import { ProviderReferenceOverrideSchema } from '@repo/schemas/common'
import { Notice } from '@repo/ui/components/ds/feedback'
import {
  Button,
  mutationFeedback,
  type ButtonFeedback,
} from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { Label } from '@repo/ui/components/ui/label'
import { fetchApiData } from '@/utils/api'
import { jobDetailOptions } from '@/utils/job-data'
import { canCancelJob } from '@/utils/job-selection'
import { unconfirmedWrite } from '@/utils/write-feedback'
import { DetailLink } from './detail-link'
import { jobButtonFeedback } from './job-button-feedback'
import { FindMatch, type FindMatchContext } from './find-match'
import { errorMessage } from './lastfm-sync'
import { useConfig } from './providers'

/** Stores an identifier for an album or film; it wins over scraped ones. */
function saveMediaIdentifier(
  apiBaseUrl: string,
  item: AlbumDetail | FilmDetail,
  override: z.infer<typeof ProviderReferenceOverrideSchema>,
) {
  return fetchApiData(
    apiBaseUrl,
    `/api/v1/${item.mediaType === 'film' ? 'films' : 'albums'}/${encodeURIComponent(item.id)}`,
    z.union([AlbumDetailSchema, FilmDetailSchema]),
    {
      method: 'PATCH',
      body: JSON.stringify({ referenceOverrides: [override] }),
    },
  )
}

/** Films share IMDb and TMDb identifiers across providers. */
function identifierProvider(
  item: AlbumDetail | FilmDetail,
  id: string,
  referenceType: string,
) {
  return item.mediaType === 'film' && ['imdb', 'tmdb'].includes(referenceType)
    ? referenceType
    : id
}

/**
 * Find match for an album or film: choosing a candidate does what Save and
 * refresh does with its identifier.
 */
export function MediaFindMatch({
  item,
  provider,
  label,
  context,
  onSaved,
  onRefresh,
}: {
  item: AlbumDetail | FilmDetail
  provider: string
  label: string
  context: FindMatchContext
  onSaved: () => Promise<void>
  /** Queues a refresh after saving. Without it the ID is only saved. */
  onRefresh?: () => Promise<Job>
}) {
  const { apiBaseUrl } = useConfig()
  const saved = useRef<Pick<
    z.infer<typeof ProviderReferenceOverrideSchema>,
    'externalId' | 'referenceType'
  > | null>(null)
  const retryRefresh = useRef(onRefresh)
  retryRefresh.current = onRefresh ?? retryRefresh.current
  const [requestingRefresh, setRequestingRefresh] = useState(false)
  return (
    <FindMatch
      scope={{ kind: item.mediaType, id: item.id }}
      provider={provider}
      label={label}
      context={context}
      choosePending={
        requestingRefresh ? 'ID saved · requesting refresh…' : 'Saving ID…'
      }
      onChoose={async (candidate) => {
        const alreadySaved =
          saved.current?.externalId === candidate.externalId &&
          saved.current.referenceType === candidate.referenceType
        if (!alreadySaved) {
          await saveMediaIdentifier(
            apiBaseUrl,
            item,
            ProviderReferenceOverrideSchema.parse({
              provider: identifierProvider(
                item,
                provider,
                candidate.referenceType,
              ),
              referenceType: candidate.referenceType,
              externalId: candidate.externalId,
            }),
          )
          saved.current = candidate
          void onSaved()
        }
        const request = alreadySaved ? retryRefresh.current : onRefresh
        if (!request) return
        setRequestingRefresh(true)
        try {
          return { job: await request() }
        } catch (error) {
          return {
            refreshError: errorMessage(error, 'Could not request a refresh.'),
          }
        } finally {
          setRequestingRefresh(false)
        }
      }}
    />
  )
}

export function IdentifierRow({
  item,
  provider,
  label,
  referenceType,
  current,
  onSaved,
  onRefresh,
  onCancel,
}: {
  item: AlbumDetail | FilmDetail
  provider: string
  label: string
  referenceType: string
  current: string
  onSaved: () => Promise<void>
  /** Queues a refresh after saving. Without it the ID is only saved. */
  onRefresh?: () => Promise<Job>
  onCancel?: () => void
}) {
  const { apiBaseUrl } = useConfig()
  const [value, setValue] = useState(current)
  const [error, setError] = useState('')
  const refresh = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!onRefresh) throw new Error('Refresh is currently unavailable.')
      return onRefresh()
    },
  })
  const mutation = useMutation({
    retry: false,
    mutationFn: (override: z.infer<typeof ProviderReferenceOverrideSchema>) =>
      saveMediaIdentifier(apiBaseUrl, item, override),
    onSuccess: (_, input) => {
      setValue(input.externalId)
      if (onRefresh) refresh.mutate()
      void onSaved()
    },
  })
  const receipt = useQuery({
    ...jobDetailOptions(apiBaseUrl, refresh.data?.id ?? ''),
    initialData: refresh.data,
    enabled: Boolean(refresh.data && canCancelJob(refresh.data)),
  })
  const job = receipt.data ?? refresh.data
  const busy = mutation.isPending || refresh.isPending
  const canRetryRefresh =
    mutation.isSuccess && refresh.isError && Boolean(onRefresh)
  const feedback: ButtonFeedback | undefined = refresh.isPending
    ? { phase: 'pending', label: 'ID saved · requesting refresh…' }
    : refresh.isError
      ? { phase: 'partial', label: 'ID saved · retry refresh' }
      : job
        ? jobButtonFeedback(job, 'Source updated')
        : (unconfirmedWrite(mutation.error) ??
          mutationFeedback(mutation, {
            pending: 'Saving ID…',
            success: 'ID saved',
            error: 'Could not save ID',
          }))
  const id = `identifier-${provider}-${referenceType}`
  const action = onRefresh ? 'Save and refresh' : 'Save'
  return (
    <form
      className="data-identifier"
      onSubmit={(event) => {
        event.preventDefault()
        if (busy) return
        const result = ProviderReferenceOverrideSchema.safeParse({
          provider,
          referenceType,
          externalId: value,
        })
        if (!result.success) {
          setError(result.error.issues[0]?.message ?? 'Invalid ID')
          return
        }
        if (
          canRetryRefresh &&
          result.data.externalId === mutation.variables?.externalId
        ) {
          refresh.mutate()
          return
        }
        if (result.data.externalId === current) return
        setError('')
        refresh.reset()
        mutation.mutate(result.data)
      }}
    >
      <Label htmlFor={id}>
        {referenceType === 'imdb'
          ? 'IMDb ID, shared across providers'
          : `${referenceType} ID`}
      </Label>
      <Input
        id={id}
        aria-label={`${label} ID`}
        value={value}
        disabled={busy}
        placeholder={
          referenceType === 'imdb' ? 'tt... or IMDb title URL' : 'Missing ID'
        }
        onChange={(event) => setValue(event.target.value)}
      />
      <span className="ds-actions">
        <Button
          variant="primary"
          type="submit"
          disabled={
            !value.trim() ||
            busy ||
            (value.trim() === current && !canRetryRefresh)
          }
          feedback={feedback}
        >
          {canRetryRefresh ? 'Retry refresh' : action}
        </Button>
        {onCancel && (
          <Button type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </span>
      {(error || mutation.isError) && (
        <Notice tone="danger" className="data-identifier-wide">
          {error ||
            (unconfirmedWrite(mutation.error)
              ? 'The save could not be confirmed. Check the current identifier before trying again.'
              : errorMessage(mutation.error, 'Could not save the ID.'))}
        </Notice>
      )}
      {refresh.isError && (
        <Notice tone="danger" className="data-identifier-wide">
          {errorMessage(refresh.error, 'Could not request a refresh.')}
        </Notice>
      )}
      {job && (
        <span className="ds-muted data-identifier-wide">
          ID saved ·{' '}
          <DetailLink kind="job" id={job.id}>
            View refresh job
          </DetailLink>
          {job.errorMessage && ` · ${job.errorMessage}`}
        </span>
      )}
    </form>
  )
}

export function mediaProviderIdentifiers(
  item: AlbumDetail | FilmDetail,
  id: string,
  provider?: ProviderSummary,
) {
  const owned = item.providerReferences.filter(
    (reference) => reference.provider === id,
  )
  const referenceTypes = new Set([
    ...owned.map((reference) => reference.referenceType),
    ...(provider?.identifierTypes ?? []),
  ])
  return [...referenceTypes].map((referenceType) => {
    const shared =
      item.mediaType === 'film' && ['imdb', 'tmdb'].includes(referenceType)
    const saveProvider = identifierProvider(item, id, referenceType)
    const current =
      item.providerReferences.find(
        (reference) =>
          reference.referenceType === referenceType &&
          reference.provider === saveProvider,
      )?.externalId ??
      owned.find((reference) => reference.referenceType === referenceType)
        ?.externalId ??
      (shared
        ? item.providerReferences.find(
            (reference) => reference.referenceType === referenceType,
          )?.externalId
        : undefined) ??
      ''
    return { provider: saveProvider, referenceType, current }
  })
}
