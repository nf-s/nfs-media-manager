'use client'

import { ReadButton } from '@/components/read-button'
import { useId, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { Job } from '@repo/schemas/job'
import { ExternalLink } from 'lucide-react'
import {
  MatchSearchInputSchema,
  MatchSearchResultSchema,
  UnresolvedMatchListSchema,
  type MatchCandidate,
  type MatchKind,
} from '@repo/schemas/find-match'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { List, ListRow, RowTitle } from '@repo/ui/components/ds/list-row'
import { Button, mutationFeedback } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { Label } from '@repo/ui/components/ui/label'
import { fetchApiData } from '@/utils/api'
import { errorMessage } from './lastfm-sync'
import { DetailLink } from './detail-link'
import { MediaThumb } from './media-artwork'
import { useConfig } from './providers'

export type MatchScope = { kind: MatchKind; id: string }

/** What a source row's Find match receives from the Sources list. */
export type FindMatchContext = {
  canRefresh: boolean
  /** Candidates an ambiguous lookup kept, listed without a new search. */
  stored: MatchCandidate[]
  /** The item's own search text, when known before a search. */
  query?: string
  cancel: () => void
  /** Called after a candidate is stored, to show the row's history. */
  chosen: () => void
  onJob?: (job: Job) => void
}

type FindMatchChoice = { job?: Job; refreshError?: string }

/**
 * The providers whose latest lookup for the item found no match or several.
 * Keyed under jobs so it reloads when a refresh is queued or finishes.
 */
export function useUnresolvedMatches(
  scope: MatchScope | undefined,
  enabled: boolean,
) {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: ['jobs', 'find-match-unresolved', scope?.kind, scope?.id],
    enabled: Boolean(scope) && enabled,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/find-match/unresolved?${new URLSearchParams(scope ? { kind: scope.kind, id: scope.id } : {})}`,
        UnresolvedMatchListSchema,
        { signal },
      ),
  })
}

/** The year of a provider date such as `2020`, `2020-05` or `2020-05-01`. */
export function candidateYear(value: string | null) {
  return value && /^\d{4}/.test(value) ? value.slice(0, 4) : null
}

/**
 * The search field's text: what the owner typed, else the search asked for,
 * else the query the last search used, else the item's own text. The search
 * asked for comes before any result, so the field never shows another query
 * while that search runs or after it fails.
 */
export function searchFieldValue(
  text: string | null,
  request: { q?: string } | null,
  resultQuery: string | undefined,
  itemQuery: string | undefined,
) {
  return text ?? request?.q ?? resultQuery ?? itemQuery ?? ''
}

/**
 * Searches one provider for an item, in place in its source row, and stores
 * the candidate the owner chooses.
 */
export function FindMatch({
  scope,
  provider,
  label,
  context,
  chooseUnavailable,
  onChoose,
  choosePending = 'Saving ID…',
}: {
  scope: MatchScope
  provider: string
  label: string
  context: FindMatchContext
  /** Why a candidate cannot be chosen now. */
  chooseUnavailable?: string
  onChoose: (candidate: MatchCandidate) => Promise<FindMatchChoice | void>
  choosePending?: string
}) {
  const { apiBaseUrl } = useConfig()
  const inputId = useId()
  const [text, setText] = useState<string | null>(null)
  const stored = context.stored
  // The search asked for: none while stored candidates are listed, the
  // item's own text when `q` is absent, or what the owner typed.
  const [request, setRequest] = useState<{ q?: string } | null>(
    stored.length ? null : {},
  )
  const search = useQuery({
    queryKey: [
      'find-match',
      scope.kind,
      scope.id,
      provider,
      request?.q ?? null,
    ],
    enabled: request !== null,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/find-match/search',
        MatchSearchResultSchema,
        {
          method: 'POST',
          signal,
          body: JSON.stringify(
            MatchSearchInputSchema.parse({
              kind: scope.kind,
              id: scope.id,
              provider,
              ...(request?.q ? { q: request.q } : {}),
            }),
          ),
        },
      ),
  })
  const choose = useMutation({
    retry: false,
    mutationFn: onChoose,
    onSuccess: (result) => {
      if (result?.refreshError) return
      if (result?.job) context.onJob?.(result.job)
      context.chosen()
    },
  })
  const value = searchFieldValue(
    text,
    request,
    search.data?.query,
    context.query,
  )
  const items = search.data?.items ?? (request === null ? stored : [])
  const searching = search.isFetching
  const busy = searching || choose.isPending
  return (
    <div className="data-stack">
      <form
        className="data-identifier"
        onSubmit={(event) => {
          event.preventDefault()
          const q = value.trim().slice(0, 200)
          if (!q || busy) return
          choose.reset()
          if (request?.q === q) void search.refetch()
          else setRequest({ q })
        }}
      >
        <Label htmlFor={inputId}>Search {label}</Label>
        <Input
          id={inputId}
          value={value}
          maxLength={200}
          disabled={choose.isPending}
          onChange={(event) => setText(event.target.value)}
        />
        <span className="ds-actions">
          <Button
            type="submit"
            disabled={busy || !value.trim()}
            feedback={mutationFeedback(
              {
                isPending: searching,
                isError: search.isError,
                isSuccess: search.isSuccess,
              },
              {
                pending: 'Searching…',
                success: search.data?.items.length
                  ? `${search.data.items.length} matches`
                  : 'No matches',
                error: 'Search failed',
              },
            )}
          >
            Search
          </Button>
          <Button
            type="button"
            disabled={choose.isPending}
            onClick={context.cancel}
          >
            Cancel
          </Button>
        </span>
      </form>
      {search.isError && !searching && (
        <Notice
          tone="danger"
          action={
            <ReadButton size="xs" read={() => search.refetch()}>
              Retry
            </ReadButton>
          }
        >
          {errorMessage(search.error, `Could not search ${label}.`)}
        </Notice>
      )}
      {choose.isError && (
        <Notice tone="danger">
          {errorMessage(choose.error, 'Could not save the ID.')}
        </Notice>
      )}
      {choose.data?.refreshError && choose.variables && (
        <Notice
          tone="attention"
          action={
            <Button
              feedback={{ phase: 'partial', label: 'ID saved · retry refresh' }}
              disabled={busy}
              onClick={() => {
                if (choose.variables) choose.mutate(choose.variables)
              }}
            >
              Retry refresh
            </Button>
          }
        >
          {choose.data.refreshError}
        </Notice>
      )}
      {searching ? (
        <div className="data-stack" role="status" aria-busy="true">
          <span className="sr-only">Searching {label}</span>
          <Skeleton height={48} />
          <Skeleton height={48} />
        </div>
      ) : items.length ? (
        <List compact aria-label={`${label} candidates`}>
          {items.map((candidate) => {
            const pending =
              choose.isPending &&
              choose.variables?.externalId === candidate.externalId &&
              choose.variables.referenceType === candidate.referenceType
            return (
              <ListRow
                key={`${candidate.referenceType}:${candidate.externalId}`}
                thumb={
                  <MediaThumb
                    kind={scope.kind}
                    src={candidate.artworkUrl}
                    size={40}
                  />
                }
                title={
                  <RowTitle>
                    {candidate.catalogMediaItemId ? (
                      <DetailLink
                        kind={scope.kind}
                        id={candidate.catalogMediaItemId}
                        title={candidate.title}
                      >
                        {candidate.title}
                      </DetailLink>
                    ) : (
                      <span title={candidate.title}>{candidate.title}</span>
                    )}
                  </RowTitle>
                }
                by={[
                  candidate.subtitle,
                  candidateYear(candidate.releaseDate),
                  candidate.current ? 'Current' : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                play={
                  <span className="ds-actions">
                    {candidate.url && (
                      <Button size="xs" variant="ghost" icon asChild>
                        <a
                          href={candidate.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`Open on ${label} (new tab)`}
                          aria-label={`Open ${candidate.title} on ${label} (opens in a new tab)`}
                        >
                          <ExternalLink
                            className="ds-i"
                            data-size="sm"
                            aria-hidden
                          />
                        </a>
                      </Button>
                    )}
                    <Button
                      size="xs"
                      disabled={
                        busy || candidate.current || Boolean(chooseUnavailable)
                      }
                      title={
                        candidate.current
                          ? 'Stored now'
                          : (chooseUnavailable ?? undefined)
                      }
                      aria-label={`Choose ${candidate.title}`}
                      onClick={() => choose.mutate(candidate)}
                      feedback={
                        pending
                          ? { phase: 'pending', label: choosePending }
                          : choose.isError &&
                              choose.variables?.externalId ===
                                candidate.externalId &&
                              choose.variables.referenceType ===
                                candidate.referenceType
                            ? { phase: 'failed', label: 'Could not save ID' }
                            : undefined
                      }
                    >
                      Choose
                    </Button>
                  </span>
                }
              />
            )
          })}
        </List>
      ) : null}
    </div>
  )
}
