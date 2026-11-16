'use client'

import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { z } from 'zod'
import {
  ApiKeysSchema,
  CreatedApiKeySchema,
  CreateApiKeySchema,
  RevokedApiKeySchema,
} from '@repo/schemas/api-key'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { useConfig } from '../providers'
import ExternalLink from '../external-link'
import { SecondaryCell, SecondaryDataTable } from '../secondary-table'
import { fetchApiData } from '@/utils/api'
import { apiKeyStatus, createAgentInstructions } from '@/utils/agent-access'

type CreatedKey = z.infer<typeof CreatedApiKeySchema> & {
  instructions: string | null
}

function dateLabel(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'Never'
}

function CreatedKeyDetails({
  created,
  now,
  onDone,
}: {
  created: CreatedKey
  now: number
  onDone: () => void
}) {
  const [copyStatus, setCopyStatus] = useState('')
  const output = useRef<HTMLTextAreaElement>(null)
  const expiresAt = created.apiKey.expiresAt
  const remaining = expiresAt
    ? Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 60000))
    : null
  const value = created.instructions ?? created.key
  useEffect(() => {
    output.current?.focus()
    output.current?.select()
  }, [])
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopyStatus('Copied.')
    } catch {
      output.current?.focus()
      output.current?.select()
      setCopyStatus('Copy was blocked. Copy the selected text manually.')
    }
  }
  return (
    <section
      className="grid gap-2 border-y border-slate-200 py-4"
      aria-label="Created API key"
    >
      <h2>{created.instructions ? 'Agent instructions' : 'New API key'}</h2>
      <p className="muted">
        Copy this now. The key cannot be shown again after you close it.
      </p>
      <p role="status">
        {expiresAt ? `Expires ${dateLabel(expiresAt)}` : 'No expiry'}
        {created.instructions && remaining !== null
          ? ` · ${remaining} minutes remaining`
          : ''}
      </p>
      <label className="grid gap-1">
        <span className="sr-only">
          {created.instructions ? 'Agent instructions' : 'API key'}
        </span>
        <textarea
          ref={output}
          readOnly
          spellCheck={false}
          autoComplete="off"
          className="w-full resize-y rounded-md border border-slate-300 bg-slate-50 p-3 font-mono text-xs leading-relaxed"
          rows={created.instructions ? 13 : 3}
          value={value}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" type="button" onClick={() => void copy()}>
          {created.instructions ? 'Copy agent instructions' : 'Copy API key'}
        </Button>
        <Button type="button" onClick={onDone}>
          Done
        </Button>
        {copyStatus && <span role="status">{copyStatus}</span>}
      </div>
    </section>
  )
}

export default function UserPageClient() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [name, setName] = useState('')
  const [expiry, setExpiry] = useState('2592000')
  const [created, setCreated] = useState<CreatedKey | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [notice, setNotice] = useState('')
  const keys = useQuery({
    queryKey: ['user-api-keys'],
    queryFn: ({ signal }) =>
      fetchApiData(apiBaseUrl, '/api/v1/user/api-keys', ApiKeysSchema, {
        signal,
      }),
    staleTime: 0,
    refetchInterval: 30000,
  })
  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(Date.now()),
      created ? 1000 : 30000,
    )
    return () => window.clearInterval(timer)
  }, [created])
  useEffect(() => {
    if (
      created?.apiKey.expiresAt &&
      Date.parse(created.apiKey.expiresAt) <= now
    ) {
      setCreated(null)
      setNotice(
        'The new key has expired. Create another key to grant access again.',
      )
    }
  }, [created, now])
  const create = useMutation({
    gcTime: 0,
    mutationFn: async (kind: 'manual' | 'agent') => {
      const result = await fetchApiData(
        apiBaseUrl,
        kind === 'agent'
          ? '/api/v1/user/agent-access'
          : '/api/v1/user/api-keys',
        CreatedApiKeySchema,
        {
          method: 'POST',
          body:
            kind === 'agent'
              ? undefined
              : JSON.stringify(
                  CreateApiKeySchema.parse({
                    name,
                    expiresIn: expiry === 'never' ? null : Number(expiry),
                  }),
                ),
        },
      )
      // Only component state retains the one-time secret, never the query/mutation cache.
      setCreated({
        ...result,
        instructions:
          kind === 'agent' && result.apiKey.expiresAt
            ? createAgentInstructions({
                origin: window.location.origin,
                key: result.key,
                expiresAt: result.apiKey.expiresAt,
              })
            : null,
      })
      setNow(Date.now())
      setNotice('')
      if (kind === 'manual') setName('')
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['user-api-keys'] }),
  })
  const revoke = useMutation({
    mutationFn: (id: string) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/user/api-keys/${encodeURIComponent(id)}`,
        RevokedApiKeySchema,
        { method: 'DELETE' },
      ),
    onSuccess: async ({ id }) => {
      if (created?.apiKey.id === id) setCreated(null)
      setNotice('API key revoked.')
      await client.invalidateQueries({ queryKey: ['user-api-keys'] })
    },
  })
  const creating = create.isPending || created !== null
  return (
    <section className="admin-page grid min-w-0 gap-4" aria-label="User">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1>User</h1>
        <Button asChild>
          <ExternalLink href={`${apiBaseUrl}/api/v1/scalar`}>
            API documentation
          </ExternalLink>
        </Button>
      </header>
      <div className="grid gap-2">
        <p className="muted">
          API keys allow reads and writes as your user. Key management requires
          browser sign-in.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            type="button"
            disabled={creating}
            onClick={() => create.mutate('agent')}
          >
            {create.isPending && create.variables === 'agent'
              ? 'Granting access...'
              : 'Grant Agent Access'}
          </Button>
          <span className="muted">
            Creates a key that expires in 60 minutes, with instructions to paste
            into an agent.
          </span>
        </div>
      </div>
      {created && (
        <CreatedKeyDetails
          key={created.apiKey.id}
          created={created}
          now={now}
          onDone={() => setCreated(null)}
        />
      )}
      {notice && <p role="status">{notice}</p>}
      {(create.isError || revoke.isError) && (
        <p role="alert">
          Could not {create.isError ? 'create' : 'revoke'} the key. Try again.
        </p>
      )}
      <form
        className="grid gap-2 border-t border-slate-200 pt-3"
        onSubmit={(event) => {
          event.preventDefault()
          create.mutate('manual')
        }}
      >
        <h2>Create API key</h2>
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid min-w-0 flex-1 gap-1 sm:max-w-xs">
            <span>Name</span>
            <Input
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              required
              autoComplete="off"
              placeholder="Key name"
              disabled={creating}
            />
          </label>
          <label className="grid gap-1">
            <span>Expires in</span>
            <select
              className="h-9 rounded-md border border-slate-300 bg-white px-2"
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
              disabled={creating}
            >
              <option value="3600">60 minutes</option>
              <option value="86400">1 day</option>
              <option value="2592000">30 days</option>
              <option value="7776000">90 days</option>
              <option value="31536000">1 year</option>
              <option value="never">Never</option>
            </select>
          </label>
          <Button
            size="md"
            variant="primary"
            type="submit"
            disabled={creating || !name.trim()}
          >
            {create.isPending && create.variables === 'manual'
              ? 'Creating...'
              : 'Create key'}
          </Button>
        </div>
      </form>
      <section className="grid min-w-0 gap-2" aria-label="API keys">
        <h2>API keys</h2>
        {keys.isError && keys.data && (
          <p role="alert">
            Could not refresh API keys.{' '}
            <button type="button" onClick={() => void keys.refetch()}>
              Retry
            </button>
          </p>
        )}
        <SecondaryDataTable
          id="user-api-keys"
          label="API keys"
          rows={keys.data ?? []}
          rowKey={(key) => key.id}
          defaultSort={{ key: 'createdAt', direction: 'desc' }}
          search={{
            label: 'Search API keys',
            value: (key) => `${key.name} ${key.start}`,
          }}
          countLabel="keys"
          busy={keys.isPending}
          error={keys.isError}
          empty={
            keys.isPending ? (
              'Loading API keys...'
            ) : keys.isError ? (
              <>
                Could not load API keys.{' '}
                <button type="button" onClick={() => void keys.refetch()}>
                  Retry
                </button>
              </>
            ) : (
              'No API keys.'
            )
          }
          columns={[
            {
              key: 'name',
              label: 'Name',
              required: true,
              value: (key) => key.name,
            },
            {
              key: 'start',
              label: 'Prefix',
              value: (key) => key.start,
              render: (key) => (
                <SecondaryCell>
                  <code>{key.start}…</code>
                </SecondaryCell>
              ),
            },
            {
              key: 'status',
              label: 'Status',
              value: (key) => apiKeyStatus(key, now),
            },
            {
              key: 'createdAt',
              label: 'Created',
              value: (key) => Date.parse(key.createdAt),
              render: (key) => (
                <SecondaryCell>{dateLabel(key.createdAt)}</SecondaryCell>
              ),
            },
            {
              key: 'expiresAt',
              label: 'Expires',
              value: (key) =>
                key.expiresAt ? Date.parse(key.expiresAt) : null,
              render: (key) => (
                <SecondaryCell>{dateLabel(key.expiresAt)}</SecondaryCell>
              ),
            },
            {
              key: 'lastRequest',
              label: 'Last used',
              value: (key) =>
                key.lastRequest ? Date.parse(key.lastRequest) : null,
              render: (key) => (
                <SecondaryCell>{dateLabel(key.lastRequest)}</SecondaryCell>
              ),
            },
            {
              key: 'actions',
              label: 'Actions',
              sortable: false,
              required: true,
              value: () => null,
              render: (key) => (
                <Button
                  type="button"
                  disabled={!key.enabled || revoke.isPending}
                  aria-label={`Revoke ${key.name}`}
                  onClick={() => revoke.mutate(key.id)}
                >
                  {revoke.isPending && revoke.variables === key.id
                    ? 'Revoking...'
                    : 'Revoke'}
                </Button>
              ),
            },
          ]}
        />
      </section>
    </section>
  )
}
