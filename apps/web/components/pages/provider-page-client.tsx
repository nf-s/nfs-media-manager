'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { z } from 'zod'
import type { JobActivitySchema } from '@repo/schemas/job'
import {
  ProviderJobSummarySchema,
  ProviderSummarySchema,
  type ProviderOverviewItem,
  type ProviderSummary,
} from '@repo/schemas/provider'
import {
  DetailActionsSpacer,
  DetailHeader,
} from '@repo/ui/components/ds/detail-header'
import { KeyValues, Section } from '@repo/ui/components/ds/facts'
import { Notice, Skeleton, State } from '@repo/ui/components/ds/feedback'
import { Progress } from '@repo/ui/components/ds/meter'
import { Count, Pill, Pills, ProviderMark } from '@repo/ui/components/ds/pill'
import { Status } from '@repo/ui/components/ds/status'
import { Button } from '@repo/ui/components/ui/button'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@repo/ui/components/ui/tabs'
import { formatCount, formatItemCount, formatUntil } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import {
  activeCooldownUntil,
  connectionStatus,
  parseProviderTab,
  providerJobsHref,
  providerMarkText,
  providerOverviewQuery,
  providerRoleLabels,
  queueBlocked,
  queueStatus,
  runsOnLabel,
  type ProviderTab,
} from '@/utils/provider-overview'
import { useConfig } from '../providers'
import { JobsTable } from '../jobs-table'
import {
  ProviderRecentActivity,
  ProviderRequests,
  ProviderReviewableErrors,
} from '../provider-activity'
import ProviderConfiguration, {
  formatLimitDuration,
} from '../provider-configuration'
import ProviderCredentials from '../provider-credentials'
import {
  ProviderCooldownConfirm,
  useProviderCooldown,
  type ProviderCooldown,
} from '../provider-cooldown'
import {
  ProviderDispatchActions,
  ProviderDispatchNotes,
  ProviderDispatchReview,
  ProviderWorkerModeSwitch,
  dispatchStateLabel,
  useProviderDispatch,
  type ProviderDispatch,
} from '../provider-job-dispatch'
import ProviderJobSummary from '../provider-job-summary'
import {
  ProviderLocalWorkerBadge,
  useProviderLocalWorker,
  useProviderLocalWorkerMode,
} from '../provider-local-worker'

function useProviderSummaries() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  return useQuery({
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
}

function Crumbs({ name }: { name: string }) {
  return (
    <nav aria-label="Breadcrumb" className="ds-crumbs providers-crumbs">
      <Link href="/providers">Providers</Link>
      <ChevronRight className="ds-i" data-size="sm" aria-hidden />
      <b>{name}</b>
    </nav>
  )
}

export default function ProviderPageClient({
  providerId,
}: {
  providerId: string
}) {
  const { apiBaseUrl } = useConfig()
  const summaries = useProviderSummaries()
  const overview = useQuery(providerOverviewQuery(apiBaseUrl, null))
  const provider = summaries.data?.find(
    (item) => item.id === providerId && item.surface === 'provider',
  )
  if (!provider)
    return (
      <div className="ds-page providers-page">
        {summaries.isPending ? (
          <>
            <Skeleton className="providers-crumbs-skeleton" />
            <Skeleton className="providers-head-skeleton" />
          </>
        ) : summaries.isError ? (
          <State
            error
            title="Could not load provider"
            action={<Button onClick={() => summaries.refetch()}>Retry</Button>}
          />
        ) : (
          <State
            title="Provider not found"
            action={
              <Button asChild>
                <Link href="/providers">All providers</Link>
              </Button>
            }
          />
        )}
      </div>
    )
  return (
    <ProviderDetail
      key={provider.id}
      provider={provider}
      item={overview.data?.providers.find((item) => item.id === provider.id)}
      overviewLoading={overview.isPending}
    />
  )
}

function ProviderDetail({
  provider,
  item,
  overviewLoading,
}: {
  provider: ProviderSummary
  item: ProviderOverviewItem | undefined
  overviewLoading: boolean
}) {
  const { apiBaseUrl } = useConfig()
  const search = useSearchParams()
  const tab = parseProviderTab(search.get('tab'))
  const id = provider.id
  const localWorker = useProviderLocalWorker(provider)
  const worker = localWorker.isError ? undefined : localWorker.data
  const dispatch = useProviderDispatch(provider)
  const cooldown = useProviderCooldown(id)
  const changeMode = useProviderLocalWorkerMode(id)
  const jobs = useQuery({
    queryKey: ['jobs', 'provider-summary', id],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/providers/${encodeURIComponent(id)}/jobs/summary`,
        ProviderJobSummarySchema,
      ),
    staleTime: 0,
    refetchInterval: 10000,
  })
  function openTab(value: string) {
    const next = parseProviderTab(value)
    const params = new URLSearchParams(window.location.search)
    if (next === 'overview') params.delete('tab')
    else params.set('tab', next)
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${params.size ? `?${params}` : ''}`,
    )
  }
  const safetyCooldown =
    provider.safety?.cooldownUntil &&
    Date.parse(provider.safety.cooldownUntil) > Date.now()
      ? provider.safety.cooldownUntil
      : null
  const queueCooldown = item ? activeCooldownUntil(item.queue) : null
  const connection = item ? connectionStatus(item.connection) : null
  const queue = item ? queueStatus(item.queue) : null
  const active = jobs.data ? jobs.data.queued + jobs.data.running : 0
  return (
    <div className="ds-page providers-page" data-tab={tab}>
      <Crumbs name={provider.displayName} />
      <DetailHeader
        headingLevel={1}
        art={
          <ProviderMark name={provider.displayName}>
            {providerMarkText(provider.displayName)}
          </ProviderMark>
        }
        kind="Provider"
        title={provider.displayName}
        facts={[
          queue && (
            <Status state={queue.state} title={queue.title}>
              {queue.label}
            </Status>
          ),
          provider.description,
          connection && (
            <Status state={connection.state} title={connection.title}>
              {connection.label}
            </Status>
          ),
          item && runsOnLabel(item),
        ]}
        actions={
          <>
            <ProviderDispatchActions
              dispatch={dispatch}
              busy={changeMode.isPending}
            />
            {safetyCooldown && !queueCooldown && !cooldown.confirming && (
              <Button size="md" onClick={() => cooldown.start(safetyCooldown)}>
                Clear cooldown
              </Button>
            )}
            <DetailActionsSpacer />
            <Button size="md" variant="ghost" asChild>
              <Link href={providerJobsHref(id)}>Open in Jobs</Link>
            </Button>
          </>
        }
      />
      <Tabs value={tab} onValueChange={openTab} className="providers-tabs">
        <TabsList aria-label="Provider sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="jobs">
            Jobs {active > 0 && <Count>{formatCount(active)}</Count>}
          </TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <div className="providers-notices">
          {item && (
            <WaitingNotice
              item={item}
              tab={tab}
              cooldown={cooldown}
              dispatch={dispatch}
              onOpenSettings={() => openTab('settings')}
            />
          )}
          {provider.safety?.halted &&
            item?.queue.reason !== 'access-denied' && (
              <Notice tone="danger">
                Requests halted after access denial. Check account access before
                updating credentials.
              </Notice>
            )}
          {localWorker.isError && (
            <Notice
              tone="danger"
              action={
                <Button size="xs" onClick={() => localWorker.refetch()}>
                  Retry
                </Button>
              }
            >
              Could not load local worker status.
            </Notice>
          )}
          <ProviderCooldownConfirm cooldown={cooldown} />
          <ProviderDispatchReview
            dispatch={dispatch}
            busy={changeMode.isPending}
          />
        </div>
        <TabsContent value="overview">
          <div className="ds-page-cols providers-cols">
            <div>
              {jobs.isPending && <Skeleton className="providers-stats" />}
              {jobs.isError && (
                <State
                  size="sm"
                  error
                  title="Could not load job summary"
                  action={
                    <Button size="xs" onClick={() => jobs.refetch()}>
                      Retry
                    </Button>
                  }
                />
              )}
              {jobs.data && (
                <ProviderJobSummary
                  summary={jobs.data}
                  onOpenJobs={() => openTab('jobs')}
                />
              )}
              <ProviderRequests provider={provider} />
              <ProviderRecentActivity provider={provider} />
            </div>
            <div>
              <QueueSection
                provider={provider}
                item={item}
                loading={overviewLoading}
                dispatch={dispatch}
                onEdit={() => openTab('settings')}
              />
              <Section
                title="Credentials"
                aside={
                  <Button variant="link" onClick={() => openTab('settings')}>
                    Edit
                  </Button>
                }
              >
                {provider.secrets.length ? (
                  <KeyValues
                    items={provider.secrets.map((field) => ({
                      label: field.label,
                      value: (
                        <Status
                          state={
                            field.configured
                              ? 'done'
                              : field.required
                                ? 'attention'
                                : 'never'
                          }
                        >
                          {field.configured ? 'Set' : 'Missing'}
                        </Status>
                      ),
                    }))}
                  />
                ) : (
                  <p className="ds-help">
                    This provider does not require credentials.
                  </p>
                )}
              </Section>
              {item && item.roles.length > 0 && (
                <Section title="Supplies">
                  <Pills wrap label="Supplies">
                    {providerRoleLabels(item).map((label) => (
                      <Pill key={label}>{label}</Pill>
                    ))}
                  </Pills>
                </Section>
              )}
            </div>
          </div>
        </TabsContent>
        <TabsContent value="jobs" className="providers-jobs">
          <JobsTable provider={id} />
        </TabsContent>
        <TabsContent value="settings">
          <div className="ds-page-cols providers-cols">
            <div>
              <ProviderCredentials provider={provider} />
              <ProviderConfiguration provider={provider} />
            </div>
            <div>
              {provider.supportsLocalWorker && (
                <Section title="Local worker">
                  {localWorker.isPending && (
                    <Skeleton className="providers-field" />
                  )}
                  {worker && <ProviderLocalWorkerBadge status={worker} />}
                  {provider.supportsJobDispatchControl && (
                    <ProviderWorkerModeSwitch
                      worker={worker}
                      dispatch={dispatch}
                      changeMode={changeMode}
                    />
                  )}
                </Section>
              )}
              <ProviderReviewableErrors provider={provider} />
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function sentence(text: string) {
  const trimmed = text.trim()
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/** Why the queue is held, with the action that releases it. Shown on every tab. */
function WaitingNotice({
  item,
  tab,
  cooldown,
  dispatch,
  onOpenSettings,
}: {
  item: ProviderOverviewItem
  tab: ProviderTab
  cooldown: ProviderCooldown
  dispatch: ProviderDispatch
  onOpenSettings: () => void
}) {
  const { queue } = item
  if (
    queue.state !== 'waiting' &&
    queue.state !== 'paused' &&
    queue.state !== 'stopped'
  )
    return null
  const until = activeCooldownUntil(queue)
  const held = queue.reason === 'paused' || queue.reason === 'stopped'
  const settings =
    queue.reason === 'access-denied' ||
    queue.reason === 'budget' ||
    queue.reason === 'worker-offline'
  const action =
    until && !cooldown.confirming ? (
      <Button size="xs" onClick={() => cooldown.start(until)}>
        Clear cooldown
      </Button>
    ) : held &&
      dispatch.provider.supportsJobDispatchControl &&
      dispatch.data &&
      !dispatch.reviewing ? (
      <Button
        size="xs"
        disabled={dispatch.waitingToResume || dispatch.update.isPending}
        onClick={() => dispatch.startReview('resume')}
      >
        {dispatch.resumeLabel}
      </Button>
    ) : settings && tab !== 'settings' ? (
      <Button size="xs" onClick={onOpenSettings}>
        Open settings
      </Button>
    ) : undefined
  const parts = [
    sentence(queue.detail ?? queueStatus(queue).label),
    queue.until && queue.reason !== 'queued'
      ? `The queue resumes at ${formatUntil(queue.until)}.`
      : '',
    item.jobs.queued > 0
      ? `${formatItemCount(item.jobs.queued, { one: 'job is', other: 'jobs are' })} waiting.`
      : '',
  ].filter(Boolean)
  return (
    <Notice
      tone={
        queue.state === 'stopped'
          ? 'danger'
          : queueBlocked(queue)
            ? 'attention'
            : undefined
      }
      action={action}
    >
      {parts.join(' ')}
    </Notice>
  )
}

function QueueSection({
  provider,
  item,
  loading,
  dispatch,
  onEdit,
}: {
  provider: ProviderSummary
  item: ProviderOverviewItem | undefined
  loading: boolean
  dispatch: ProviderDispatch
  onEdit: () => void
}) {
  const queue = item ? queueStatus(item.queue) : null
  const dispatcher = dispatchStateLabel(dispatch)
  return (
    <Section
      title="Queue"
      flush
      aside={
        <Button variant="link" onClick={onEdit}>
          Edit limits
        </Button>
      }
    >
      {loading && !item ? (
        <Skeleton className="providers-field" />
      ) : (
        <KeyValues
          items={[
            ...(queue
              ? [
                  {
                    label: 'State',
                    value: (
                      <Status state={queue.state} title={queue.title}>
                        {queue.label}
                      </Status>
                    ),
                  },
                ]
              : []),
            ...(dispatcher ? [{ label: 'Dispatcher', value: dispatcher }] : []),
            ...(item ? [{ label: 'Runs on', value: runsOnLabel(item) }] : []),
            {
              label: 'Concurrency',
              value: `${formatCount(
                item?.concurrency ??
                  (provider.rateLimit.concurrentRequests
                    ? provider.rateLimit.maxConcurrent
                    : 1),
              )} at a time`,
            },
            {
              label: 'Interval',
              value: `${formatLimitDuration(provider.rateLimit.minTimeMs)} between requests`,
            },
            {
              label: 'After a limit',
              value: provider.rateLimit.retryAfterIsAuthoritative
                ? `Retry-After (${formatLimitDuration(provider.rateLimit.rateLimitCooldownMs)} fallback)`
                : formatLimitDuration(provider.rateLimit.rateLimitCooldownMs),
            },
            ...(item?.budget
              ? [
                  {
                    label:
                      item.budget.period === 'day'
                        ? 'Daily budget'
                        : 'Hourly budget',
                    value: (
                      <Progress
                        done={item.budget.used}
                        total={item.budget.limit}
                        tone={
                          item.budget.used / item.budget.limit > 0.8
                            ? 'attention'
                            : undefined
                        }
                      />
                    ),
                  },
                  {
                    label: 'Budget resets',
                    value: formatUntil(item.budget.resetsAt),
                  },
                ]
              : []),
          ]}
        />
      )}
      <ProviderDispatchNotes dispatch={dispatch} />
    </Section>
  )
}
