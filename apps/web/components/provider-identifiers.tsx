'use client'

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { z } from 'zod'
import type { ProviderSummary } from '@repo/schemas/provider'
import {
  AlbumDetailSchema,
  FilmDetailSchema,
  type AlbumDetail,
  type FilmDetail,
} from '@repo/schemas/media'
import { ProviderReferenceOverrideSchema } from '@repo/schemas/common'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { Label } from '@repo/ui/components/ui/label'
import { fetchApiData } from '@/utils/api'
import { errorMessage } from './lastfm-sync'
import { useConfig } from './providers'

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
  onRefresh?: () => Promise<unknown>
  onCancel?: () => void
}) {
  const { apiBaseUrl } = useConfig()
  const [value, setValue] = useState(current)
  const [error, setError] = useState('')
  const mutation = useMutation({
    mutationFn: async (
      override: z.infer<typeof ProviderReferenceOverrideSchema>,
    ) => {
      await fetchApiData(
        apiBaseUrl,
        `/api/v1/${item.mediaType === 'film' ? 'films' : 'albums'}/${encodeURIComponent(item.id)}`,
        z.union([AlbumDetailSchema, FilmDetailSchema]),
        {
          method: 'PATCH',
          body: JSON.stringify({ referenceOverrides: [override] }),
        },
      )
      await onSaved()
      if (onRefresh) await onRefresh()
    },
  })
  const id = `identifier-${provider}-${referenceType}`
  const action = onRefresh ? 'Save and refresh' : 'Save'
  return (
    <form
      className="data-identifier"
      onSubmit={(event) => {
        event.preventDefault()
        const result = ProviderReferenceOverrideSchema.safeParse({
          provider,
          referenceType,
          externalId: value,
        })
        if (!result.success) {
          setError(result.error.issues[0]?.message ?? 'Invalid ID')
          return
        }
        setError('')
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
            !value.trim() || value.trim() === current || mutation.isPending
          }
        >
          {mutation.isPending ? 'Saving...' : action}
        </Button>
        {onCancel && (
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </span>
      {(error || mutation.isError) && (
        <Notice tone="danger" className="data-identifier-wide">
          {error || errorMessage(mutation.error, 'Could not save the ID.')}
        </Notice>
      )}
      {mutation.isSuccess && (
        <span role="status" className="ds-muted data-identifier-wide">
          {onRefresh ? 'Saved. Refresh queued.' : 'Saved'}
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
    const saveProvider = shared ? referenceType : id
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
