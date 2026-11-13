'use client'

import { useEffect, useId, useRef, useState } from 'react'
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
  invalidateManualMediaAddition,
} from '@/utils/manual-media-add'
import { useConfig } from './providers'
import { errorMessage } from './lastfm-sync'
import MediaArtwork from './media-artwork'

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
          <Button type="submit" disabled={busy || !query.trim()}>
            {search.isPending ? 'Searching…' : 'Search'}
          </Button>
        </div>
      </form>
      {search.isPending && <p role="status">Searching {provider}…</p>}
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
      {result && !search.isPending && (
        <>
          {result.items.length === 0 ? (
            <p role="status">
              No matching {mediaType === 'album' ? 'albums' : 'films'}.
            </p>
          ) : (
            <ul
              className="manual-add-results"
              aria-label={`${provider} results`}
            >
              {result.items.map((item) => {
                const inLibrary = Boolean(
                  item.mediaItemId || addedIds.current.has(item.externalId),
                )
                const pending =
                  add.isPending && add.variables?.externalId === item.externalId
                return (
                  <li key={item.externalId} className="manual-add-result">
                    <MediaArtwork
                      src={item.artworkUrl}
                      alt=""
                      fallbackLabel="No art"
                      containerClassName={`manual-add-artwork ${mediaType === 'film' ? 'manual-add-poster' : ''}`}
                      imageClassName="manual-add-image"
                      fallbackClassName="manual-add-image"
                    />
                    <div className="manual-add-description">
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        title={`Open on ${provider}`}
                      >
                        {item.title}
                      </a>
                      {item.subtitle && (
                        <p className="quiet">{item.subtitle}</p>
                      )}
                      <p className="quiet">
                        {item.releaseDate?.slice(0, 4)}
                        {inLibrary && (
                          <span>{item.releaseDate ? ' · ' : ''}In library</span>
                        )}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
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
                  </li>
                )
              })}
            </ul>
          )}
          {(result.page > 1 || result.hasMore) && (
            <div className="manual-add-pagination">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || result.page <= 1}
                onClick={() => find(result.page - 1)}
              >
                Previous
              </Button>
              <span>Page {result.page}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
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
