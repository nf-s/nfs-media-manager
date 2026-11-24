'use client'

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useVirtualRows, useVirtualTable } from '@/hooks/useVirtualTable'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import {
  ManualMediaSearchInputSchema,
  ManualMediaSearchResultSchema,
  type ManualMediaSearchInput,
  type ManualMediaSearchItem,
  type ManualMediaSearchResult,
} from '@repo/schemas/manual-add'
import { SPOTIFY_TRACK_SEARCH_LIMIT } from '@repo/schemas/spotify-track-search'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { Label } from '@repo/ui/components/ui/label'
import { Notice, Skeleton, State } from '@repo/ui/components/ds/feedback'
import { LibraryAction } from '@repo/ui/components/ds/library-action'
import { List, ListRow, RowTitle } from '@repo/ui/components/ds/list-row'
import { fetchApiData } from '@/utils/api'
import {
  addManualMediaItem,
  describeSearchItem,
  loadManualSearchPage,
  invalidateManualMediaAddition,
  orderSearchItems,
} from '@/utils/manual-media-add'
import { useConfig } from './providers'
import { errorMessage } from './lastfm-sync'
import { MediaThumb } from './media-artwork'
import ServiceIconLinks from './service-icon-links'
import { DetailLink } from './detail-link'

/** One result row: the 48px list row with its bottom border. */
const RESULT_ROW_HEIGHT = 49

const searchFields = {
  album: { provider: 'Spotify', placeholder: 'Album or artist', pageSize: 10 },
  film: { provider: 'TMDb', placeholder: 'Film title', pageSize: 20 },
  track: {
    provider: 'Spotify',
    placeholder: 'Track or artist',
    pageSize: SPOTIFY_TRACK_SEARCH_LIMIT,
  },
}

export function ManualMediaSearch({
  mediaType,
  initialQuery = '',
  onAdded,
  existingActionLabel = 'Open',
  disabled = false,
  onPendingChange,
  autoSearch = false,
  initialResult,
  onSearchResult,
  onChoose,
  tracksPlayed,
}: {
  mediaType: ManualMediaSearchInput['mediaType']
  initialQuery?: string
  onAdded: (id: string) => void | Promise<void>
  existingActionLabel?: string
  disabled?: boolean
  onPendingChange?: (pending: boolean) => void
  autoSearch?: boolean
  initialResult?: ManualMediaSearchResult
  onSearchResult?: (query: string, result: ManualMediaSearchResult) => void
  onChoose?: (item: ManualMediaSearchItem) => void
  /**
   * How many different tracks were played from the album being looked for.
   * Results with fewer tracks say so and are listed last.
   */
  tracksPlayed?: number
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [query, setQuery] = useState(initialQuery.slice(0, 200))
  const addedIds = useRef(new Map<string, string>())
  const automaticallySearched = useRef(false)
  const [showInitialResult, setShowInitialResult] = useState(true)
  const { provider, placeholder } = searchFields[mediaType]
  const inputId = useId()
  const isLinking = Boolean(onChoose) || existingActionLabel !== 'Open'
  const exactMembership = isLinking ? undefined : true
  const search = useMutation({
    retry: false,
    mutationFn: (input: ManualMediaSearchInput) =>
      client.fetchQuery({
        queryKey: [
          'manual-media-search',
          input.mediaType,
          input.q,
          input.page ?? 1,
          input.exactMembership ?? false,
        ],
        staleTime: 0,
        retry: false,
        queryFn: () =>
          fetchApiData(
            apiBaseUrl,
            '/api/v1/manual-add/search',
            ManualMediaSearchResultSchema,
            {
              method: 'POST',
              body: JSON.stringify(ManualMediaSearchInputSchema.parse(input)),
            },
          ),
      }),
    onSuccess: (result, input) => onSearchResult?.(input.q, result),
  })
  const add = useMutation({
    retry: false,
    mutationFn: async (item: ManualMediaSearchItem) => {
      let id = item.mediaItemId ?? addedIds.current.get(item.externalId)
      if (!id) {
        id = await addManualMediaItem(apiBaseUrl, mediaType, item)
        addedIds.current.set(item.externalId, id)
        await invalidateManualMediaAddition(client, mediaType)
      }
      await onAdded(id)
    },
  })
  const found = search.data ?? (showInitialResult ? initialResult : undefined)
  const result = useMemo(
    () =>
      found && { ...found, items: orderSearchItems(found.items, tracksPlayed) },
    [found, tracksPlayed],
  )
  const liveSearch = search.isSuccess && result?.page === 1
  const { mutate: searchMedia } = search
  useEffect(() => {
    if (
      !autoSearch ||
      disabled ||
      initialResult ||
      automaticallySearched.current ||
      !initialQuery.trim()
    )
      return
    automaticallySearched.current = true
    searchMedia({
      mediaType,
      q: initialQuery.trim().slice(0, 200),
      page: 1,
      exactMembership,
    })
  }, [
    autoSearch,
    disabled,
    exactMembership,
    initialQuery,
    initialResult,
    mediaType,
    searchMedia,
  ])
  const busy = disabled || search.isPending || add.isPending
  useEffect(() => {
    onPendingChange?.(add.isPending)
  }, [add.isPending, onPendingChange])

  function find(page = 1) {
    if (busy || !query.trim()) return
    add.reset()
    setShowInitialResult(false)
    search.mutate({
      mediaType,
      q: query.trim(),
      page,
      exactMembership,
    })
  }

  return (
    <div className="sec-stack">
      <form
        className="sec-form-row"
        onSubmit={(event) => {
          event.preventDefault()
          find()
        }}
      >
        <div className="ds-field">
          <Label htmlFor={inputId}>Search {provider}</Label>
          <Input
            id={inputId}
            controlSize="md"
            value={query}
            maxLength={200}
            placeholder={placeholder}
            disabled={busy}
            onChange={(event) => {
              setQuery(event.target.value)
              setShowInitialResult(false)
              search.reset()
              add.reset()
            }}
          />
        </div>
        <Button
          size="md"
          variant="primary"
          type="submit"
          disabled={busy || !query.trim()}
        >
          {search.isPending ? 'Searching…' : 'Search'}
        </Button>
      </form>
      {search.isError && (
        <Notice tone="danger">
          {errorMessage(search.error, `Could not search ${provider}.`)}
        </Notice>
      )}
      {add.isError && (
        <Notice tone="danger">
          {errorMessage(add.error, `Could not add ${mediaType}.`)}
        </Notice>
      )}
      {(result || search.isPending || search.isError) && (
        <>
          <ManualSearchResults
            mediaType={mediaType}
            query={search.variables?.q ?? initialQuery}
            result={search.isPending ? undefined : result}
            revision={search.submittedAt}
            loading={search.isPending}
            liveSearch={liveSearch}
            exactMembership={exactMembership}
            tracksPlayed={tracksPlayed}
            disabled={disabled || add.isPending}
            renderItem={(item) => {
              const libraryId =
                item.mediaItemId ?? addedIds.current.get(item.externalId)
              const detailId = item.catalogMediaItemId ?? libraryId
              const inLibrary = Boolean(libraryId)
              const pending =
                add.isPending && add.variables?.externalId === item.externalId
              return (
                <ListRow
                  title={
                    <RowTitle>
                      {detailId ? (
                        <DetailLink
                          kind={mediaType}
                          id={detailId}
                          title={item.title}
                          onClick={(event) => {
                            if (
                              isLinking ||
                              item.catalogMediaItemId ||
                              event.defaultPrevented ||
                              event.button !== 0 ||
                              event.metaKey ||
                              event.altKey ||
                              event.ctrlKey ||
                              event.shiftKey
                            )
                              return
                            event.preventDefault()
                            if (!busy) add.mutate(item)
                          }}
                        >
                          {item.title}
                        </DetailLink>
                      ) : (
                        <span title={item.title}>{item.title}</span>
                      )}
                    </RowTitle>
                  }
                  thumb={
                    <MediaThumb
                      kind={mediaType}
                      src={item.artworkUrl}
                      size={40}
                    />
                  }
                  by={describeSearchItem(item, { inLibrary, tracksPlayed })}
                  play={
                    <span className="ds-actions">
                      <ServiceIconLinks
                        links={[{ provider, label: provider, url: item.url }]}
                        itemTitle={item.title}
                      />
                      {isLinking ? (
                        <Button
                          type="button"
                          size="xs"
                          disabled={busy}
                          aria-label={`${inLibrary ? existingActionLabel : 'Add'} ${item.title}`}
                          onClick={() =>
                            onChoose ? onChoose(item) : add.mutate(item)
                          }
                        >
                          {pending
                            ? 'Saving…'
                            : inLibrary
                              ? existingActionLabel
                              : 'Add'}
                        </Button>
                      ) : (
                        <LibraryAction
                          kind={mediaType}
                          name={item.title}
                          saved={inLibrary}
                          pending={pending}
                          disabled={busy}
                          onAdd={() => add.mutate(item)}
                        />
                      )}
                    </span>
                  }
                />
              )
            }}
          />
          {result &&
            (result.totalCount === undefined || !liveSearch) &&
            (result.page > 1 || result.hasMore) && (
              <span className="sec-line">
                <Button
                  type="button"
                  disabled={busy || result.page <= 1}
                  onClick={() => find(result.page - 1)}
                >
                  Previous
                </Button>
                <span className="ds-muted">Page {result.page}</span>
                <Button
                  type="button"
                  disabled={busy || !result.hasMore || result.page >= 50}
                  onClick={() => find(result.page + 1)}
                >
                  Next
                </Button>
              </span>
            )}
        </>
      )}
    </div>
  )
}

/** Stored searches stay bounded until the user explicitly searches again. */
function ManualSearchResults({
  mediaType,
  query,
  result,
  revision,
  loading,
  liveSearch,
  exactMembership,
  tracksPlayed,
  disabled,
  renderItem,
}: {
  mediaType: ManualMediaSearchInput['mediaType']
  query: string
  result: ManualMediaSearchResult | undefined
  revision: number
  loading: boolean
  liveSearch: boolean
  exactMembership?: boolean
  tracksPlayed: number | undefined
  disabled: boolean
  renderItem: (item: ManualMediaSearchItem) => ReactNode
}) {
  const { apiBaseUrl } = useConfig()
  const { pageSize, provider } = searchFields[mediaType]
  const rowHeight = RESULT_ROW_HEIGHT
  const storedOnly = Boolean(
    result && !loading && (!liveSearch || result.totalCount === undefined),
  )
  const storedRows = useVirtualRows({
    rows: storedOnly ? (result?.items ?? []) : [],
    identity: `${mediaType}:${query}:${revision}`,
    rowHeight,
    headerHeight: 0,
  })
  const results = useVirtualTable({
    queryKey: [
      'manual-media-search-window',
      mediaType,
      query,
      revision,
      liveSearch,
      exactMembership,
    ],
    pageSize,
    rowHeight,
    headerHeight: 0,
    enabled:
      Boolean(result) && !storedOnly && !loading && liveSearch && !disabled,
    loadPage: (page, _size, signal) =>
      loadManualSearchPage({
        apiBaseUrl,
        mediaType,
        query,
        page,
        stored: result,
        liveSearch,
        exactMembership,
        tracksPlayed,
        signal,
      }),
  })
  const window = storedOnly ? storedRows : results
  return (
    <>
      <div
        ref={window.scroller}
        onScroll={window.onScroll}
        className="sec-bounded sec-results"
        role="region"
        aria-label={`${provider} results`}
        aria-busy={!storedOnly && (loading || results.isFetching)}
        tabIndex={0}
      >
        {!loading && (storedOnly || results.hasTotal) && window.total === 0 && (
          <State
            size="sm"
            title={
              mediaType === 'track' &&
              result &&
              (result.hasMore || result.page > 1)
                ? 'No available tracks on this page'
                : `No ${mediaType}s match`
            }
          />
        )}
        <List compact>
          {window.padTop > 0 && (
            <div aria-hidden="true" style={{ height: window.padTop }} />
          )}
          {window.slots.map(({ item, index }) =>
            item ? (
              <div
                key={index}
                className="sec-result-slot"
                style={{ height: RESULT_ROW_HEIGHT }}
              >
                {renderItem(item)}
              </div>
            ) : (
              <div
                key={index}
                className="sec-result-slot"
                style={{ height: RESULT_ROW_HEIGHT }}
                aria-hidden="true"
              >
                <Skeleton height={RESULT_ROW_HEIGHT - 16} />
              </div>
            ),
          )}
          {window.padBottom > 0 && (
            <div aria-hidden="true" style={{ height: window.padBottom }} />
          )}
        </List>
      </div>
      {!storedOnly && results.isError && (
        <Notice
          tone="danger"
          action={
            <Button size="xs" onClick={results.retry}>
              Retry
            </Button>
          }
        >
          Could not load results.
        </Notice>
      )}
    </>
  )
}

export default function ManualMediaAdd({
  mediaType,
  initialQuery,
  onClose,
  onAdded,
}: {
  mediaType: ManualMediaSearchInput['mediaType']
  initialQuery?: string
  onClose: () => void
  onAdded: (id: string) => void | Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [pending, setPending] = useState(false)
  useEffect(() => {
    const element = dialog.current
    const previous = document.activeElement
    if (!element?.open) element?.showModal()
    element?.querySelector('input')?.focus()
    return () => {
      element?.close()
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true })
    }
  }, [])
  return (
    <dialog
      ref={dialog}
      className="sec-drawer"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!pending) onClose()
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (!pending && event.target === event.currentTarget) onClose()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="ds-inspector">
        <div className="ds-inspector-bar">
          <h2 id={titleId} className="ds-crumbs">
            <b>Add {mediaType}</b>
          </h2>
          <Button
            variant="ghost"
            icon
            aria-label={`Close add ${mediaType}`}
            disabled={pending}
            onClick={onClose}
          >
            <X className="ds-i" aria-hidden="true" />
          </Button>
        </div>
        <div className="ds-inspector-body">
          <ManualMediaSearch
            mediaType={mediaType}
            initialQuery={initialQuery}
            onAdded={onAdded}
            onPendingChange={setPending}
          />
        </div>
      </div>
    </dialog>
  )
}
