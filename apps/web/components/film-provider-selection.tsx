'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import {
  ProviderSummarySchema,
  type ProviderSummary,
} from '@repo/schemas/provider'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import type { MediaScope } from '@/utils/media-scope'

export function useMediaProviders(mediaType: MediaScope = 'film') {
  const { apiBaseUrl } = useConfig()
  const [selection, setSelected] = useState<string[] | null>(null)
  const query = useQuery({
    queryKey: ['providers'],
    staleTime: 30000,
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/providers',
        z.array(ProviderSummarySchema),
      ),
  })
  const providers =
    query.data?.filter(
      (provider) =>
        provider.supportsScrape && provider.mediaTypes.includes(mediaType),
    ) ?? []
  const selected =
    selection ??
    providers
      .filter(
        (provider) =>
          !provider.safety?.halted &&
          provider.secrets.every(
            (field) => !field.required || field.configured,
          ),
      )
      .map((provider) => provider.id)
  return {
    providers,
    selected,
    setSelected,
    isPending: query.isPending,
    isError: query.isError,
  }
}

export const useFilmProviders = useMediaProviders

export function FilmProviderSelection({
  providers,
  selected,
  onChange,
  disabled,
}: {
  providers: ProviderSummary[]
  selected: string[]
  onChange: (providers: string[]) => void
  disabled?: boolean
}) {
  return (
    <fieldset className="enrichment-providers" disabled={disabled}>
      <legend>Fetch metadata from</legend>
      {providers.map((provider) => {
        const missing = provider.secrets.some(
          (field) => field.required && !field.configured,
        )
        return (
          <label className="check-label" key={provider.id}>
            <input
              type="checkbox"
              checked={selected.includes(provider.id)}
              disabled={missing || provider.safety?.halted}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, provider.id]
                    : selected.filter((id) => id !== provider.id),
                )
              }
            />
            {provider.displayName}
            {missing
              ? ' (needs credentials)'
              : provider.safety?.halted
                ? ' (halted)'
                : provider.safety?.cooldownUntil
                  ? ' (waits for cooldown)'
                  : ''}
          </label>
        )
      })}
      {!providers.length && (
        <span className="muted">No scrapers configured for this library.</span>
      )}
    </fieldset>
  )
}
