'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import type { JobActivitySchema } from '@repo/schemas/job'
import {
  ProviderSecretsSchema,
  ProviderSummarySchema,
  ProviderJobSummarySchema,
} from '@repo/schemas/provider'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@repo/ui/components/ui/tabs'
import { useConfig } from '@/components/providers'
import { fetchApiData } from '@/utils/api'
import ProviderActivity from '../provider-activity'
import ProviderConfiguration from '../provider-configuration'
import ProviderJobSummary from '../provider-job-summary'
import ProviderJobDispatch from '../provider-job-dispatch'
import { JobsTable } from './jobs-page-client'
import { SectionSidebar, SectionWorkspace } from '../section-sidebar'
import { useWorkspaceScope } from '../media-scope'

export default function ProvidersPageClient() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const search = useSearchParams()
  const urlScope = useWorkspaceScope()
  const selected = search.get('provider') ?? ''
  const section = search.get('section') ?? 'activity'
  const [draft, setDraft] = useState<Record<string, string>>({})
  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/providers',
        z.array(ProviderSummarySchema),
      ),
    refetchInterval: (query) => {
      const jobs = client.getQueryData<z.infer<typeof JobActivitySchema>>([
        'job-activity',
      ])
      const coolingDown = query.state.data?.some(
        (provider) =>
          provider.safety?.cooldownUntil &&
          Date.parse(provider.safety.cooldownUntil) > Date.now(),
      )
      return (jobs && jobs.queued + jobs.running > 0) || coolingDown
        ? 10000
        : false
    },
  })
  // A provider link without `mediaType` opens in that provider's library.
  const target = providers.data?.find((item) => item.id === selected)
  const targetScope =
    target?.mediaTypes[0] ?? (target?.subscriptions ? 'subscription' : null)
  const mediaType =
    !search.has('mediaType') && targetScope ? targetScope : urlScope
  // Subscriptions lists its own providers. Other account-level providers
  // belong to neither media library and appear in both.
  const available =
    providers.data?.filter(
      (provider) =>
        provider.surface === 'provider' &&
        (mediaType === 'subscription'
          ? provider.subscriptions
          : provider.mediaTypes.includes(mediaType) ||
            (provider.mediaTypes.length === 0 && !provider.subscriptions)),
    ) ?? []
  useEffect(() => {
    if (search.has('mediaType') || !targetScope) return
    const params = new URLSearchParams(window.location.search)
    params.set('mediaType', targetScope)
    window.history.replaceState(null, '', `/providers?${params}`)
  }, [search, targetScope])
  const provider =
    available.find((provider) => provider.id === selected) ?? available[0]
  const id = provider?.id ?? ''
  const jobs = useQuery({
    queryKey: ['jobs', 'provider-summary', id],
    enabled: !!id,
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/providers/${encodeURIComponent(id)}/jobs/summary`,
        ProviderJobSummarySchema,
      ),
    staleTime: 0,
    refetchInterval: 10000,
  })
  const hasJobs = (jobs.data?.total ?? 0) > 0
  const activeSection =
    ['activity', 'credentials', 'settings'].includes(section) ||
    (section === 'jobs' && hasJobs)
      ? section
      : 'activity'
  function openSection(value: string) {
    const params = new URLSearchParams(window.location.search)
    params.set('provider', id)
    params.set('section', value)
    window.history.replaceState(null, '', `/providers?${params}`)
  }
  const secrets = useQuery({
    queryKey: ['provider-secrets', id],
    enabled: !!id,
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/providers/${id}/secrets`,
        ProviderSecretsSchema,
      ),
  })
  const save = useMutation({
    mutationFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/providers/${id}/secrets`,
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
      await client.invalidateQueries({ queryKey: ['provider-secrets', id] })
      await client.invalidateQueries({ queryKey: ['providers'] })
    },
  })
  const test = useMutation({
    mutationFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/providers/${id}/test`,
        ProviderSecretsSchema,
        { method: 'POST' },
      ),
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: ['provider-secrets', id] })
      await client.invalidateQueries({ queryKey: ['providers'] })
    },
  })
  const resetSave = save.reset
  const resetTest = test.reset
  useEffect(() => {
    setDraft({})
    resetSave()
    resetTest()
  }, [id, resetSave, resetTest])
  return (
    <SectionWorkspace
      sidebar={
        <div className="min-h-0 overflow-auto">
          <SectionSidebar
            label="Providers"
            activeId={id}
            items={available.map((item) => ({
              id: item.id,
              label: item.displayName,
              description: item.safety?.halted
                ? 'Access halted'
                : item.safety?.cooldownUntil
                  ? 'Cooling down'
                  : item.secrets.some(
                        (field) => field.required && !field.configured,
                      )
                    ? 'Needs credentials'
                    : item.mediaTypes.length === 0
                      ? 'Account sync'
                      : !item.supportsScrape
                        ? 'Import only'
                        : undefined,
              onSelect: () => {
                const params = new URLSearchParams(window.location.search)
                params.set('provider', item.id)
                params.set('mediaType', mediaType)
                params.delete('jobId')
                params.delete('batchId')
                window.history.replaceState(null, '', `/providers?${params}`)
                setDraft({})
                save.reset()
                test.reset()
              },
            }))}
          />
        </div>
      }
    >
      <section
        className={`admin-page${activeSection === 'jobs' ? ' jobs-page' : ''}`}
      >
        {providers.isPending && <p className="muted">Loading providers...</p>}
        {providers.isError && (
          <p role="alert">
            Could not load providers.{' '}
            <button onClick={() => providers.refetch()}>Retry</button>
          </p>
        )}
        {provider && (
          <div
            className="provider-editor"
            style={
              activeSection === 'jobs'
                ? {
                    display: 'flex',
                    flexDirection: 'column',
                    flex: '1 1 0%',
                    minHeight: 0,
                    maxWidth: 'none',
                  }
                : undefined
            }
          >
            <header className="provider-header">
              <h1>{provider.displayName}</h1>
              <p className="muted">{provider.description}</p>
              {provider.safety?.halted && (
                <p role="alert">
                  Requests halted after access denial. Check account access
                  before updating credentials.
                </p>
              )}
            </header>
            <Tabs
              value={activeSection}
              onValueChange={openSection}
              className={
                activeSection === 'jobs'
                  ? 'flex min-h-0 flex-1 flex-col'
                  : undefined
              }
            >
              <TabsList
                aria-label="Provider sections"
                className="provider-tabs"
              >
                <TabsTrigger value="activity">Activity</TabsTrigger>
                {hasJobs && <TabsTrigger value="jobs">Jobs</TabsTrigger>}
                <TabsTrigger value="credentials">Credentials</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
              </TabsList>
              <TabsContent value="activity" className="provider-panel">
                {jobs.isPending && <p role="status">Loading jobs...</p>}
                {jobs.isError && (
                  <p role="alert">
                    Could not load job summary.{' '}
                    <button onClick={() => jobs.refetch()}>Retry</button>
                  </p>
                )}
                {jobs.data && (
                  <ProviderJobSummary
                    summary={jobs.data}
                    onOpenJobs={() => openSection('jobs')}
                  />
                )}
                <ProviderJobDispatch
                  key={`dispatch-${provider.id}`}
                  provider={provider}
                />
                <ProviderActivity key={provider.id} provider={provider} />
              </TabsContent>
              {hasJobs && (
                <TabsContent
                  value="jobs"
                  className="provider-panel min-h-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col"
                >
                  <ProviderJobDispatch key={provider.id} provider={provider} />
                  <div className="min-h-0 flex-1">
                    <JobsTable key={provider.id} provider={provider.id} />
                  </div>
                </TabsContent>
              )}
              <TabsContent value="credentials" className="provider-panel">
                <form
                  className="provider-credentials"
                  onSubmit={(event) => {
                    event.preventDefault()
                    save.mutate()
                  }}
                >
                  <h2>Credentials</h2>
                  {!!secrets.data?.fields.length && (
                    <p className="muted">
                      Leave a field blank to keep its current value.
                    </p>
                  )}
                  {secrets.isPending && (
                    <p role="status">Loading credentials...</p>
                  )}
                  {secrets.data?.fields.length === 0 && (
                    <p className="muted">
                      This provider does not require credentials.
                    </p>
                  )}
                  <div className="provider-credential-fields">
                    {secrets.data?.fields.map((field) => (
                      <label key={field.key}>
                        <span className="provider-field-heading">
                          <strong>{field.label}</strong>
                          <span className="muted">
                            {field.required ? 'Required' : 'Optional'} ·{' '}
                            {field.configured ? 'Configured' : 'Missing'}
                          </span>
                        </span>
                        <Input
                          type="password"
                          aria-label={field.label}
                          autoComplete="new-password"
                          placeholder={field.placeholder ?? 'Enter a new value'}
                          value={draft[field.key] ?? ''}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              [field.key]: event.target.value,
                            })
                          }
                        />
                        {field.helpText && (
                          <span className="muted">{field.helpText}</span>
                        )}
                        {provider.credentialEnvironment.find(
                          (item) => item.key === field.key,
                        )?.envVars.length ? (
                          <span className="muted">
                            Environment fallback:{' '}
                            {provider.credentialEnvironment
                              .find((item) => item.key === field.key)
                              ?.envVars.join(', ')}
                          </span>
                        ) : null}
                      </label>
                    ))}
                  </div>
                  {(!!secrets.data?.fields.length ||
                    provider.supportsTestConnection) && (
                    <div className="form-actions">
                      {!!secrets.data?.fields.length && (
                        <Button
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
                          type="button"
                          variant="outline"
                          disabled={
                            test.isPending ||
                            provider.safety?.halted ||
                            !!provider.safety?.cooldownUntil
                          }
                          onClick={() => test.mutate()}
                        >
                          {test.isPending ? 'Checking...' : 'Check credentials'}
                        </Button>
                      )}
                    </div>
                  )}
                  {save.isSuccess && <p role="status">Saved.</p>}
                  {(save.isError || test.isError || secrets.isError) && (
                    <p role="alert">
                      Request failed. Check the notification for details.
                    </p>
                  )}
                  {provider.supportsTestConnection ? (
                    <p className="muted" role="status">
                      {test.data?.lastVerifiedStatus ??
                        secrets.data?.lastVerifiedStatus ??
                        'Not checked'}
                      {secrets.data?.lastVerifiedAt
                        ? ` · ${new Date(secrets.data.lastVerifiedAt).toLocaleString()}`
                        : ''}
                    </p>
                  ) : (
                    !!secrets.data?.fields.length && (
                      <p className="muted">
                        Remote credential checks are not supported by this
                        provider.
                      </p>
                    )
                  )}
                </form>
              </TabsContent>
              <TabsContent value="settings" className="provider-panel">
                <ProviderConfiguration provider={provider} />
              </TabsContent>
            </Tabs>
          </div>
        )}
        {!providers.isPending && !providers.isError && !provider && (
          <p className="muted">No providers configured.</p>
        )}
      </section>
    </SectionWorkspace>
  )
}
