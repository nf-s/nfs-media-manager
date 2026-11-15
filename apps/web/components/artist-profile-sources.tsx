'use client'

import Link from 'next/link'
import { useState } from 'react'
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  ArtistEnrichmentInputSchema,
  ArtistProfileProviderSchema,
  type ArtistProfileProvider,
  type ArtistProviderSnapshot,
} from '@repo/schemas/artist-profiles'
import { ArtistHistoryPageSchema } from '@repo/schemas/creators'
import { JobPageSchema, JobSchema, type Job } from '@repo/schemas/job'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { fetchApiData } from '@/utils/api'
import { jobPagesPollInterval } from '@/utils/job-cache'
import { activeJobProgressLabel, canCancelJob } from '@/utils/job-selection'
import { CreatorLibraryDate } from './creator-library-table'
import { useDetailView } from './detail-inspector-context'
import JsonTree from './json-tree'
import { errorMessage } from './lastfm-sync'
import { useConfig } from './providers'
import {
  SecondaryCell,
  SecondaryDataTable,
  type DataColumn,
} from './secondary-table'
import ServiceIconLinks from './service-icon-links'

const providerLabels: Record<ArtistProfileProvider, string> = {
  spotify: 'Spotify',
  lastfm: 'Last.fm',
  discogs: 'Discogs',
  musicbrainz: 'MusicBrainz',
}

const jobLabels: Record<Job['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

function jobHref(id: string) {
  return `/jobs?${new URLSearchParams({ mediaType: 'album', jobId: id })}`
}

export function ArtistProfileLinks({
  snapshots,
}: {
  snapshots: ArtistProviderSnapshot[]
}) {
  return (
    <ServiceIconLinks
      links={snapshots.flatMap(({ provider, profile }) =>
        profile.url
          ? [{ provider, label: providerLabels[provider], url: profile.url }]
          : [],
      )}
    />
  )
}

const sourceColumns: DataColumn<ArtistProviderSnapshot>[] = [
  {
    key: 'provider',
    label: 'Provider',
    value: ({ provider }) => providerLabels[provider],
    render: (snapshot) => (
      <div className="secondary-cell-actions">
        <span>{providerLabels[snapshot.provider]}</span>
        <ArtistProfileLinks snapshots={[snapshot]} />
      </div>
    ),
  },
  {
    key: 'externalId',
    label: 'Artist ID',
    value: ({ profile }) => profile.externalId,
    render: ({ profile }) => (
      <SecondaryCell>{profile.externalId ?? '-'}</SecondaryCell>
    ),
  },
  {
    key: 'updatedAt',
    label: 'Updated',
    value: ({ createdAt }) => Date.parse(createdAt),
    render: ({ createdAt }) => (
      <CreatorLibraryDate value={createdAt} withTime />
    ),
  },
]

export function ArtistProfileSources({
  id,
  snapshots,
}: {
  id: string
  snapshots: ArtistProviderSnapshot[]
}) {
  return (
    <div className="space-y-4">
      <ArtistProfileRefresh id={id} />
      <SecondaryDataTable
        id="artist-profile-sources"
        label="Current profile sources"
        rows={snapshots}
        columns={sourceColumns}
        rowKey={(snapshot) => snapshot.id}
        defaultSort={{ key: 'provider', direction: 'asc' }}
        empty="No artist profiles stored."
      />
    </div>
  )
}

function ArtistProfileRefresh({ id }: { id: string }) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [provider, setProvider] = useState<ArtistProfileProvider | ''>('')
  const [providerArtistId, setProviderArtistId] = useState('')
  const jobs = useQuery({
    queryKey: ['jobs', 'artist-enrichment', id],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/scrape/jobs?${new URLSearchParams({ artistId: id, sortBy: 'createdAt', direction: 'desc', size: '10' })}`,
        JobPageSchema,
        { signal },
      ),
    refetchInterval: (query) =>
      jobPagesPollInterval(query.state.data ? [query.state.data] : undefined),
  })
  const refresh = useMutation({
    mutationFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/artists/${encodeURIComponent(id)}/enrichment`,
        JobSchema,
        {
          method: 'POST',
          body: JSON.stringify(
            ArtistEnrichmentInputSchema.parse({
              provider,
              providerArtistId: providerArtistId.trim() || undefined,
            }),
          ),
        },
      ),
    onSuccess: (job) => {
      client.setQueryData(['jobs', 'detail', job.id], job)
      void Promise.all([
        client.invalidateQueries({ queryKey: ['jobs'] }),
        client.invalidateQueries({ queryKey: ['job-activity'] }),
      ])
    },
  })
  const recentJobs = jobs.data?.items ?? []
  const queuedJob =
    refresh.data &&
    (recentJobs.find((job) => job.id === refresh.data.id) ?? refresh.data)
  const hasActiveJob =
    recentJobs.some((job) => job.provider === provider && canCancelJob(job)) ||
    (queuedJob?.provider === provider && canCancelJob(queuedJob))

  return (
    <div className="space-y-2">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (provider && !refresh.isPending && !hasActiveJob) refresh.mutate()
        }}
      >
        <label className="grid gap-1 text-sm">
          Provider
          <select
            className="h-8 rounded-md border border-[var(--line)] bg-white px-2"
            value={provider}
            disabled={refresh.isPending}
            onChange={(event) => {
              const parsed = ArtistProfileProviderSchema.safeParse(
                event.target.value,
              )
              setProvider(parsed.success ? parsed.data : '')
              setProviderArtistId('')
              refresh.reset()
            }}
          >
            <option value="">Choose provider</option>
            {ArtistProfileProviderSchema.options.map((value) => (
              <option key={value} value={value}>
                {providerLabels[value]}
              </option>
            ))}
          </select>
        </label>
        {provider && (
          <label className="grid min-w-0 gap-1 text-sm">
            {provider === 'lastfm'
              ? 'Artist MBID or URL (optional)'
              : 'Artist ID (optional)'}
            <Input
              className="h-8"
              value={providerArtistId}
              maxLength={1000}
              disabled={refresh.isPending}
              onChange={(event) => setProviderArtistId(event.target.value)}
            />
          </label>
        )}
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={!provider || refresh.isPending || hasActiveJob}
        >
          {refresh.isPending ? 'Queuing...' : 'Refresh profile'}
        </Button>
      </form>
      {refresh.isError && (
        <p role="alert" className="quiet">
          {errorMessage(refresh.error, 'Could not queue the profile refresh.')}
        </p>
      )}
      {queuedJob && (
        <p className="quiet" role="status">
          {jobLabels[queuedJob.status]}.{' '}
          <Link href={jobHref(queuedJob.id)} className="underline">
            View job
          </Link>
        </p>
      )}
      {jobs.isError && !recentJobs.length && (
        <p className="quiet" role="alert">
          Could not load profile jobs.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => jobs.refetch()}
          >
            Retry
          </button>
        </p>
      )}
      {recentJobs.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm">
            Recent profile jobs
          </summary>
          <ul className="mt-1 grid gap-1 text-sm">
            {recentJobs.map((job) => {
              const parsed = ArtistProfileProviderSchema.safeParse(job.provider)
              const label = parsed.success
                ? providerLabels[parsed.data]
                : job.provider
              const progress = activeJobProgressLabel(job)
              return (
                <li
                  key={job.id}
                  className="flex flex-wrap items-center gap-x-2"
                >
                  <Link
                    href={jobHref(job.id)}
                    className="underline underline-offset-2"
                  >
                    {label}
                  </Link>
                  <span className="quiet">
                    {jobLabels[job.status]}
                    {progress && ` · ${progress}`}
                  </span>
                  <span className="quiet">
                    <CreatorLibraryDate value={job.createdAt} withTime />
                  </span>
                </li>
              )
            })}
          </ul>
        </details>
      )}
    </div>
  )
}

function ArtistProfileHistoryEvent({
  snapshot,
}: {
  snapshot: ArtistProviderSnapshot
}) {
  const [open, setOpen] = useState(false)
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <strong>{providerLabels[snapshot.provider]}</strong>
        <span>{snapshot.profile.name}</span>
        {snapshot.scrapeJobId && (
          <Link
            href={jobHref(snapshot.scrapeJobId)}
            className="shrink-0 text-xs underline underline-offset-2"
          >
            View job
          </Link>
        )}
        <CreatorLibraryDate value={snapshot.createdAt} withTime />
      </summary>
      {open && <JsonTree value={snapshot.profile} />}
    </details>
  )
}

export function ArtistProfileHistory({ id }: { id: string }) {
  const { apiBaseUrl } = useConfig()
  const view = useDetailView()
  const providerParam = ArtistProfileProviderSchema.safeParse(
    view.params.get('provider'),
  )
  const provider = providerParam.success ? providerParam.data : ''
  const history = useInfiniteQuery({
    queryKey: ['artist', id, 'history', provider],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/artists/${encodeURIComponent(id)}/history?${new URLSearchParams({ page: String(pageParam), size: '20', ...(provider ? { provider } : {}) })}`,
        ArtistHistoryPageSchema,
        { signal },
      ),
    getNextPageParam: (last) =>
      last.page < last.pageCount ? last.page + 1 : undefined,
  })
  const snapshots = new Map<string, ArtistProviderSnapshot>()
  for (const page of history.data?.pages ?? []) {
    for (const snapshot of page.items) {
      if (!snapshots.has(snapshot.id)) snapshots.set(snapshot.id, snapshot)
    }
  }
  return (
    <section aria-label="Profile history" className="space-y-2">
      <label className="flex items-center gap-2 text-sm">
        Provider
        <select
          className="h-8 rounded-md border border-[var(--line)] bg-white px-2"
          value={provider}
          onChange={(event) => {
            if (event.target.value)
              view.params.set('provider', event.target.value)
            else view.params.delete('provider')
            view.replace(view.params)
          }}
        >
          <option value="">All providers</option>
          {ArtistProfileProviderSchema.options.map((value) => (
            <option key={value} value={value}>
              {providerLabels[value]}
            </option>
          ))}
        </select>
      </label>
      {history.isPending && (
        <p className="quiet" role="status">
          Loading profile history...
        </p>
      )}
      {history.isError && !history.isFetchNextPageError && (
        <p className="quiet" role="alert">
          Could not load profile history.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => history.refetch()}
          >
            Retry
          </button>
        </p>
      )}
      {history.isSuccess && !snapshots.size && (
        <p className="quiet">
          No profile history for{' '}
          {provider ? providerLabels[provider] : 'this artist'}.
        </p>
      )}
      <div className="history-list">
        {[...snapshots.values()].map((snapshot) => (
          <ArtistProfileHistoryEvent key={snapshot.id} snapshot={snapshot} />
        ))}
      </div>
      {history.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={history.isFetching}
          onClick={() => history.fetchNextPage({ cancelRefetch: false })}
        >
          {history.isFetchingNextPage
            ? 'Loading more...'
            : history.isFetchNextPageError
              ? 'Retry loading history'
              : 'Load more history'}
        </Button>
      )}
    </section>
  )
}
