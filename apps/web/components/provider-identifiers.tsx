'use client'

import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { ProviderSummarySchema } from '@repo/schemas/provider'
import {
  AlbumDetailSchema,
  FilmDetailSchema,
  type AlbumDetail,
  type FilmDetail,
} from '@repo/schemas/media'
import { ProviderReferenceOverrideSchema } from '@repo/schemas/common'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { fetchApiData } from '@/utils/api'
import { useConfig } from './providers'

function IdentifierRow({
  item,
  provider,
  label,
  referenceType,
  current,
  onSaved,
}: {
  item: AlbumDetail | FilmDetail
  provider: string
  label: string
  referenceType: string
  current: string
  onSaved: () => Promise<void>
}) {
  const { apiBaseUrl } = useConfig()
  const [value, setValue] = useState(current)
  const [error, setError] = useState('')
  const mutation = useMutation({
    mutationFn: (override: z.infer<typeof ProviderReferenceOverrideSchema>) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/${item.mediaType === 'film' ? 'films' : 'albums'}/${item.id}`,
        z.union([AlbumDetailSchema, FilmDetailSchema]),
        {
          method: 'PATCH',
          body: JSON.stringify({ referenceOverrides: [override] }),
        },
      ),
    onSuccess: onSaved,
  })
  return (
    <form
      className="identifier-row"
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
      <label htmlFor={`identifier-${provider}-${referenceType}`}>
        <strong>{label}</strong>
        <small>
          {referenceType === 'imdb'
            ? 'IMDb ID, shared across providers'
            : `${referenceType} ID`}
        </small>
      </label>
      <Input
        id={`identifier-${provider}-${referenceType}`}
        aria-label={`${label} ID`}
        value={value}
        placeholder={
          referenceType === 'imdb' ? 'tt... or IMDb title URL' : 'Missing ID'
        }
        onChange={(event) => setValue(event.target.value)}
      />
      <Button
        variant="outline"
        type="submit"
        disabled={
          !value.trim() || value.trim() === current || mutation.isPending
        }
      >
        {mutation.isPending ? 'Updating...' : 'Update'}
      </Button>
      {(error || mutation.isError) && (
        <p role="alert">{error || mutation.error?.message}</p>
      )}
      {mutation.isSuccess && <span role="status">Updated</span>}
    </form>
  )
}

export default function ProviderIdentifiers({
  item,
  onSaved,
}: {
  item: AlbumDetail | FilmDetail
  onSaved: () => Promise<void>
}) {
  const { apiBaseUrl } = useConfig()
  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/providers',
        z.array(ProviderSummarySchema),
      ),
  })
  return (
    <section className="provider-identifiers">
      <h2>Provider IDs</h2>
      {providers.isError && <p role="alert">Could not load providers.</p>}
      {providers.isPending && <p className="muted">Loading providers...</p>}
      {providers.data
        ?.filter(
          (provider) =>
            provider.surface === 'provider' &&
            provider.mediaTypes.includes(item.mediaType),
        )
        .map((provider) => {
          const owned = item.providerReferences.filter(
            (reference) => reference.provider === provider.id,
          )
          const referenceType =
            (item.mediaType === 'album'
              ? owned.find((reference) => reference.isPrimary)?.referenceType
              : undefined) ??
            provider.identifierTypes[0] ??
            owned[0]?.referenceType
          if (!referenceType)
            return (
              <div className="identifier-row" key={provider.id}>
                <strong>{provider.displayName}</strong>
                <span className="muted">No item identifier</span>
              </div>
            )
          const shared =
            item.mediaType === 'film' &&
            ['imdb', 'tmdb'].includes(referenceType)
          const saveProvider = shared ? referenceType : provider.id
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
              : '') ??
            ''
          return (
            <IdentifierRow
              key={`${provider.id}:${referenceType}:${current}`}
              item={item}
              provider={saveProvider}
              label={provider.displayName}
              referenceType={referenceType}
              current={current}
              onSaved={onSaved}
            />
          )
        })}
    </section>
  )
}
