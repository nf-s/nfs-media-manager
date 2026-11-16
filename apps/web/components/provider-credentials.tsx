'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ProviderSecretsSchema,
  type ProviderSummary,
} from '@repo/schemas/provider'
import { Section } from '@repo/ui/components/ds/facts'
import { Skeleton } from '@repo/ui/components/ds/feedback'
import { Status } from '@repo/ui/components/ds/status'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { formatDateTime } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { useConfig } from './providers'

export function providerSecretsQueryKey(id: string) {
  return ['provider-secrets', id]
}

/**
 * Replaces stored credentials. Stored values never reach the browser: each
 * field shows only whether it is set, and a blank field keeps its value.
 */
export default function ProviderCredentials({
  provider,
}: {
  provider: ProviderSummary
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const id = provider.id
  const [draft, setDraft] = useState<Record<string, string>>({})
  const secrets = useQuery({
    queryKey: providerSecretsQueryKey(id),
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/providers/${encodeURIComponent(id)}/secrets`,
        ProviderSecretsSchema,
      ),
  })
  const save = useMutation({
    mutationFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/providers/${encodeURIComponent(id)}/secrets`,
        ProviderSecretsSchema,
        {
          method: 'PATCH',
          body: JSON.stringify({
            values: Object.fromEntries(
              Object.entries(draft).filter(([, value]) => value.trim()),
            ),
          }),
        },
      ),
    onSuccess: async () => {
      setDraft({})
      await client.invalidateQueries({ queryKey: providerSecretsQueryKey(id) })
      await client.invalidateQueries({ queryKey: ['providers'] })
    },
  })
  const test = useMutation({
    mutationFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/providers/${encodeURIComponent(id)}/test`,
        ProviderSecretsSchema,
        { method: 'POST' },
      ),
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: providerSecretsQueryKey(id) })
      await client.invalidateQueries({ queryKey: ['providers'] })
    },
  })
  const fields = secrets.data?.fields ?? []
  const checkBlocked =
    provider.safety?.halted || !!provider.safety?.cooldownUntil
  return (
    <Section
      title="Credentials"
      note={
        fields.length > 0
          ? 'Leave a field blank to keep its current value.'
          : undefined
      }
    >
      <form
        className="providers-form"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate()
        }}
      >
        {secrets.isPending && <Skeleton className="providers-field" />}
        {secrets.data?.fields.length === 0 && (
          <p className="ds-help">This provider does not require credentials.</p>
        )}
        {fields.map((field) => {
          const environment = provider.credentialEnvironment.find(
            (item) => item.key === field.key,
          )?.envVars
          return (
            <label key={field.key} className="ds-field">
              <span className="ds-actions">
                <span className="ds-label">{field.label}</span>
                <Status
                  state={
                    field.configured
                      ? 'done'
                      : field.required
                        ? 'attention'
                        : 'never'
                  }
                >
                  {field.required ? 'Required' : 'Optional'} ·{' '}
                  {field.configured ? 'Configured' : 'Missing'}
                </Status>
              </span>
              <Input
                type="password"
                controlSize="md"
                aria-label={field.label}
                autoComplete="new-password"
                placeholder={field.placeholder ?? 'Enter a new value'}
                value={draft[field.key] ?? ''}
                onChange={(event) =>
                  setDraft({ ...draft, [field.key]: event.target.value })
                }
              />
              {field.helpText && (
                <span className="ds-help">{field.helpText}</span>
              )}
              {environment?.length ? (
                <span className="ds-help">
                  Environment fallback: {environment.join(', ')}
                </span>
              ) : null}
            </label>
          )
        })}
        {(fields.length > 0 || provider.supportsTestConnection) && (
          <span className="ds-actions">
            {fields.length > 0 && (
              <Button
                size="md"
                variant="primary"
                type="submit"
                disabled={
                  save.isPending ||
                  !Object.values(draft).some((value) => value.trim())
                }
              >
                {save.isPending ? 'Saving...' : 'Save credentials'}
              </Button>
            )}
            {provider.supportsTestConnection && (
              <Button
                size="md"
                type="button"
                disabled={test.isPending || checkBlocked}
                onClick={() => test.mutate()}
              >
                {test.isPending ? 'Checking...' : 'Check credentials'}
              </Button>
            )}
          </span>
        )}
        {save.isSuccess && <p role="status">Saved.</p>}
        {(save.isError || test.isError || secrets.isError) && (
          <p role="alert">
            Request failed. Check the notification for details.
          </p>
        )}
        {provider.supportsTestConnection ? (
          <p className="ds-help" role="status">
            {test.data?.lastVerifiedStatus ??
              secrets.data?.lastVerifiedStatus ??
              'Not checked'}
            {secrets.data?.lastVerifiedAt
              ? ` · ${formatDateTime(secrets.data.lastVerifiedAt)}`
              : ''}
          </p>
        ) : (
          fields.length > 0 && (
            <p className="ds-help">
              Remote credential checks are not supported by this provider.
            </p>
          )
        )}
      </form>
    </Section>
  )
}
