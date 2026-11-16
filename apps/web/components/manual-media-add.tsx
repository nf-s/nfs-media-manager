'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
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
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { fetchApiData } from '@/utils/api'
import {
  addManualMediaItem,
  loadManualSearchPage,
  invalidateManualMediaAddition,
} from '@/utils/manual-media-add'
import { useConfig } from './providers'
import { errorMessage } from './lastfm-sync'
import MediaArtwork from './media-artwork'
import ServiceIconLinks from './service-icon-links'
import { DetailLink } from './detail-link'

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
}: {
  mediaType: 'album' | 'film'
  initialQuery?: string
  onAdded: (id: string) => void | Promise<void>
  existingActionLabel?: string
  disabled?: boolean
  onPendingChange?: (pending: boolean) => void
  autoSearch?: boolean
  initialResult?: ManualMediaSearchResult
  onSearchResult?: (query: string, result: ManualMediaSearchResult) => void
  onChoose?: (item: ManualMediaSearchItem) => void
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [query, setQuery] = useState(initialQuery.slice(0, 200))
  const addedIds = useRef(new Map<string, string>())
  const automaticallySearched = useRef(false)
  const [showInitialResult, setShowInitialResult] = useState(true)
  const provider = mediaType === 'album' ? 'Spotify' : 'TMDb'
  const inputId = useId()
  const search = useMutation({
    retry: false,
    mutationFn: (input: ManualMediaSearchInput) =>
      client.fetchQuery({
        queryKey: [
          'manual-media-search',
          input.mediaType,
          input.q,
          input.page ?? 1,
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
  const result = search.data ?? (showInitialResult ? initialResult : undefined)
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
    searchMedia({ mediaType, q: initialQuery.trim().slice(0, 200), page: 1 })
  }, [
    autoSearch,
    disabled,
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
    search.mutate({ mediaType, q: query.trim(), page })
  }

  return (
    <div className="manual-add-search">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          find()
        }}
      >
        <label htmlFor={inputId}>Search {provider}</label>
        <div className="manual-add-search-row">
          <Input
            id={inputId}
            value={query}
            maxLength={200}
            placeholder={
              mediaType === 'album' ? 'Album or artist' : 'Film title'
            }
            disabled={busy}
            onChange={(event) => {
              setQuery(event.target.value)
              setShowInitialResult(false)
              search.reset()
              add.reset()
            }}
          />
          <Button
            size="md"
            variant="primary"
            type="submit"
            disabled={busy || !query.trim()}
          >
            {search.isPending ? 'Searching…' : 'Search'}
          </Button>
        </div>
      </form>
      {search.isError && (
        <p role="alert">
          {errorMessage(search.error, `Could not search ${provider}.`)}
        </p>
      )}
      {add.isError && (
        <p role="alert">
          {errorMessage(add.error, `Could not add ${mediaType}.`)}
        </p>
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
            disabled={disabled || add.isPending}
            renderItem={(item) => {
              const inLibrary = Boolean(
                item.mediaItemId || addedIds.current.has(item.externalId),
              )
              const pending =
                add.isPending && add.variables?.externalId === item.externalId
              return (
                <div className="manual-add-result">
                  <MediaArtwork
                    src={item.artworkUrl}
                    alt=""
                    fallbackLabel="No art"
                    containerClassName={`manual-add-artwork ${mediaType === 'film' ? 'manual-add-poster' : ''}`}
                    imageClassName="manual-add-image"
                    fallbackClassName="manual-add-image"
                  />
                  <div
                    className="manual-add-description"
                    title={[item.title, item.subtitle]
                      .filter(Boolean)
                      .join(' — ')}
                  >
                    <div className="flex items-center gap-1.5">
                      {item.mediaItemId ? (
                        <DetailLink kind={mediaType} id={item.mediaItemId}>
                          {item.title}
                        </DetailLink>
                      ) : (
                        <span>{item.title}</span>
                      )}
                      <ServiceIconLinks
                        links={[{ provider, label: provider, url: item.url }]}
                      />
                    </div>
                    {item.subtitle && <p className="quiet">{item.subtitle}</p>}
                    <p className="quiet">
                      {item.releaseDate?.slice(0, 4)}
                      {inLibrary && (
                        <span>{item.releaseDate ? ' · ' : ''}In library</span>
                      )}
                    </p>
                  </div>
                  <Button
                    type="button"
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
                </div>
              )
            }}
          />
          {result &&
            (result.totalCount === undefined || !liveSearch) &&
            (result.page > 1 || result.hasMore) && (
              <div className="manual-add-pagination">
                <Button
                  type="button"
                  disabled={busy || result.page <= 1}
                  onClick={() => find(result.page - 1)}
                >
                  Previous
                </Button>
                <span>Page {result.page}</span>
                <Button
                  type="button"
                  disabled={busy || !result.hasMore || result.page >= 50}
                  onClick={() => find(result.page + 1)}
                >
                  Next
                </Button>
              </div>
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
  disabled,
  renderItem,
}: {
  mediaType: 'album' | 'film'
  query: string
  result: ManualMediaSearchResult | undefined
  revision: number
  loading: boolean
  liveSearch: boolean
  disabled: boolean
  renderItem: (item: ManualMediaSearchItem) => ReactNode
}) {
  const { apiBaseUrl } = useConfig()
  const pageSize = mediaType === 'album' ? 10 : 20
  const rowHeight = mediaType === 'album' ? 88 : 106
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
        signal,
      }),
  })
  const window = storedOnly ? storedRows : results
  return (
    <>
      <div
        ref={window.scroller}
        onScroll={window.onScroll}
        className="manual-add-results-scroll"
        role="region"
        aria-label={`${mediaType === 'album' ? 'Spotify' : 'TMDb'} results`}
        aria-busy={!storedOnly && (loading || results.isFetching)}
        tabIndex={0}
      >
        {!loading && (storedOnly || results.hasTotal) && window.total === 0 && (
          <p role="status">
            No matching {mediaType === 'album' ? 'albums' : 'films'}.
          </p>
        )}
        <ul className="manual-add-results">
          {window.padTop > 0 && (
            <li aria-hidden="true" style={{ height: window.padTop }} />
          )}
          {window.slots.map(({ item, index }) => (
            <li
              key={index}
              className="manual-add-result-slot"
              style={{ height: rowHeight }}
            >
              {item ? (
                renderItem(item)
              ) : (
                <div
                  className="manual-add-result virtual-browse-placeholder"
                  aria-hidden="true"
                >
                  <div className="manual-add-artwork virtual-browse-shimmer" />
                  <div className="manual-add-description">
                    <div className="virtual-browse-line virtual-browse-shimmer" />
                  </div>
                </div>
              )}
            </li>
          ))}
          {window.padBottom > 0 && (
            <li aria-hidden="true" style={{ height: window.padBottom }} />
          )}
        </ul>
      </div>
      {!storedOnly && results.isError && (
        <p role="alert">
          Could not load results.{' '}
          <button className="underline" onClick={results.retry}>
            Retry
          </button>
        </p>
      )}
    </>
  )
}

export default function ManualMediaAdd({
  mediaType,
  onClose,
  onAdded,
}: {
  mediaType: 'album' | 'film'
  onClose: () => void
  onAdded: (id: string) => void
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
      className="tag-drawer manual-add-drawer"
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
      <div className="tag-drawer-inner">
        <div className="detail-topbar">
          <h1 id={titleId}>Add {mediaType}</h1>
          <button
            type="button"
            aria-label={`Close add ${mediaType}`}
            disabled={pending}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <div className="tag-drawer-body">
          <ManualMediaSearch
            mediaType={mediaType}
            onAdded={onAdded}
            onPendingChange={setPending}
          />
        </div>
      </div>
    </dialog>
  )
}
