'use client'

import { useEffect, useId, useRef, useState } from 'react'
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
import { Label } from '@repo/ui/components/ui/label'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { Status } from '@repo/ui/components/ds/status'
import { PageHead, Select } from '@repo/ui/components/ds/toolbar'
import { formatDateTime } from '@repo/ui/lib/format'
import { useConfig } from '../providers'
import ExternalLink from '../external-link'
import { SecondaryCell, SecondaryDataTable } from '../secondary-table'
import { ConfirmAction } from '../confirm-action'
import { fetchApiData } from '@/utils/api'
import { apiKeyStatus, createAgentInstructions } from '@/utils/agent-access'

type CreatedKey = z.infer<typeof CreatedApiKeySchema> & {
  instructions: string | null
}

/** A date and time, or Never for a key without an expiry or use. */
function dateLabel(value: string | null) {
  return value ? formatDateTime(value) : 'Never'
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
    <Section
      title={created.instructions ? 'Agent instructions' : 'New API key'}
    >
      <p className="ds-help">
        Copy this now. The key cannot be shown again after you close it.
      </p>
      <p role="status">
        {expiresAt ? `Expires ${dateLabel(expiresAt)}` : 'No expiry'}
        {created.instructions && remaining !== null
          ? ` · ${remaining} minutes remaining`
          : ''}
      </p>
      <label className="ds-field">
        <span className="sr-only">
          {created.instructions ? 'Agent instructions' : 'API key'}
        </span>
        <textarea
          ref={output}
          readOnly
          spellCheck={false}
          autoComplete="off"
          className="ds-input sec-textarea"
          rows={created.instructions ? 13 : 3}
          value={value}
        />
      </label>
      <span className="sec-line">
        <Button variant="primary" type="button" onClick={() => void copy()}>
          {created.instructions ? 'Copy agent instructions' : 'Copy API key'}
        </Button>
        <Button type="button" onClick={onDone}>
          Done
        </Button>
        {copyStatus && <span role="status">{copyStatus}</span>}
      </span>
    </Section>
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
  const nameId = useId()
  const expiryId = useId()
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
    <section className="sec-user" aria-label="User">
      <PageHead
        title="User"
        actions={
          <Button asChild>
            <ExternalLink href={`${apiBaseUrl}/api/v1/scalar`}>
              API documentation
            </ExternalLink>
          </Button>
        }
      />
      <div className="ds-panelpad sec-stack">
        <Section title="Agent access" flush>
          <p className="ds-help">
            API keys allow reads and writes as your user. Key management
            requires browser sign-in.
          </p>
          <span className="sec-line">
            <Button
              variant={created ? 'default' : 'primary'}
              type="button"
              disabled={creating}
              onClick={() => create.mutate('agent')}
            >
              {create.isPending && create.variables === 'agent'
                ? 'Granting access...'
                : 'Grant Agent Access'}
            </Button>
            <span className="ds-help">
              Creates a key that expires in 60 minutes, with instructions to
              paste into an agent.
            </span>
          </span>
        </Section>
        {created && (
          <CreatedKeyDetails
            key={created.apiKey.id}
            created={created}
            now={now}
            onDone={() => setCreated(null)}
          />
        )}
        {notice && <Notice>{notice}</Notice>}
        {(create.isError || revoke.isError) && (
          <Notice tone="danger">
            Could not {create.isError ? 'create' : 'revoke'} the key. Try again.
          </Notice>
        )}
        <Section title="Create API key">
          <form
            className="sec-form-row"
            onSubmit={(event) => {
              event.preventDefault()
              create.mutate('manual')
            }}
          >
            <div className="ds-field">
              <Label htmlFor={nameId}>Name</Label>
              <Input
                id={nameId}
                controlSize="md"
                name="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={100}
                required
                autoComplete="off"
                placeholder="Key name"
                disabled={creating}
              />
            </div>
            <div className="ds-field">
              <Label htmlFor={expiryId}>Expires in</Label>
              <Select
                id={expiryId}
                controlSize="md"
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
              </Select>
            </div>
            <Button size="md" type="submit" disabled={creating || !name.trim()}>
              {create.isPending && create.variables === 'manual'
                ? 'Creating...'
                : 'Create key'}
            </Button>
          </form>
        </Section>
      </div>
      <div className="ds-section-head sec-pad">
        <h3>API keys</h3>
      </div>
      {keys.isError && keys.data && (
        <div className="sec-notices">
          <Notice
            tone="danger"
            action={
              <Button size="xs" onClick={() => void keys.refetch()}>
                Retry
              </Button>
            }
          >
            Could not refresh API keys.
          </Notice>
        </div>
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
            <Skeleton width="40%" height={12} />
          ) : keys.isError ? (
            <>
              Could not load API keys.{' '}
              <Button size="xs" onClick={() => void keys.refetch()}>
                Retry
              </Button>
            </>
          ) : (
            'No API keys.'
          )
        }
        columns={[
          {
            key: 'name',
            label: 'Name',
            width: 220,
            fill: true,
            required: true,
            sticky: 0,
            stickyEdge: true,
            value: (key) => key.name,
          },
          {
            key: 'start',
            label: 'Prefix',
            width: 120,
            value: (key) => key.start,
            render: (key) => (
              <SecondaryCell>
                <code className="ds-mono">{key.start}…</code>
              </SecondaryCell>
            ),
          },
          {
            key: 'status',
            label: 'Status',
            width: 120,
            value: (key) => apiKeyStatus(key, now),
            render: (key) => {
              const status = apiKeyStatus(key, now)
              return (
                <Status
                  state={status === 'Active' ? 'done' : 'cancelled'}
                  title={status}
                >
                  {status}
                </Status>
              )
            },
          },
          {
            key: 'createdAt',
            label: 'Created',
            width: 150,
            value: (key) => Date.parse(key.createdAt),
            render: (key) => (
              <SecondaryCell>{dateLabel(key.createdAt)}</SecondaryCell>
            ),
          },
          {
            key: 'expiresAt',
            label: 'Expires',
            width: 150,
            value: (key) => (key.expiresAt ? Date.parse(key.expiresAt) : null),
            render: (key) => (
              <SecondaryCell>{dateLabel(key.expiresAt)}</SecondaryCell>
            ),
          },
          {
            key: 'lastRequest',
            label: 'Last used',
            width: 150,
            value: (key) =>
              key.lastRequest ? Date.parse(key.lastRequest) : null,
            render: (key) => (
              <SecondaryCell>{dateLabel(key.lastRequest)}</SecondaryCell>
            ),
          },
          {
            key: 'actions',
            label: 'Actions',
            width: 100,
            resizable: false,
            sortable: false,
            required: true,
            align: 'end',
            value: () => null,
            render: (key) => (
              <ConfirmAction
                size="xs"
                confirmVariant="danger"
                ariaLabel={`Revoke ${key.name}`}
                question={`Revoke ${key.name}?`}
                details="Requests that use this key stop working at once."
                confirmLabel="Revoke"
                disabled={!key.enabled || revoke.isPending}
                onConfirm={() => revoke.mutate(key.id)}
              >
                {revoke.isPending && revoke.variables === key.id
                  ? 'Revoking...'
                  : 'Revoke'}
              </ConfirmAction>
            ),
          },
        ]}
      />
    </section>
  )
}
