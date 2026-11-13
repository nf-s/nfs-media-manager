'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import {
  ManualMediaSearchInputSchema,
  ManualMediaSearchResultSchema,
  ManualMediaAddInputSchema,
  ManualMediaAddResultSchema,
  type ManualMediaSearchInput,
  type ManualMediaSearchItem,
} from '@repo/schemas/manual-add'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { fetchApiData } from '@/utils/api'
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
}: {
  mediaType: 'album' | 'film'
  initialQuery?: string
  onAdded: (id: string) => void | Promise<void>
  existingActionLabel?: string
  disabled?: boolean
  onPendingChange?: (pending: boolean) => void
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [query, setQuery] = useState(initialQuery.slice(0, 200))
  const addedIds = useRef(new Map<string, string>())
  const provider = mediaType === 'album' ? 'Spotify' : 'TMDb'
  const inputId = useId()
  const search = useMutation({
    retry: false,
    mutationFn: (input: ManualMediaSearchInput) =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/manual-add/search',
        ManualMediaSearchResultSchema,
        {
          method: 'POST',
          body: JSON.stringify(ManualMediaSearchInputSchema.parse(input)),
        },
      ),
  })
  const add = useMutation({
    retry: false,
    mutationFn: async (item: ManualMediaSearchItem) => {
      let id = item.mediaItemId ?? addedIds.current.get(item.externalId)
      if (!id) {
        const result = await fetchApiData(
          apiBaseUrl,
          '/api/v1/manual-add/add',
          ManualMediaAddResultSchema,
          {
            method: 'POST',
            body: JSON.stringify(
              ManualMediaAddInputSchema.parse({
                mediaType,
                externalId: item.externalId,
              }),
            ),
          },
        )
        id = result.mediaItemId
        addedIds.current.set(item.externalId, id)
        await Promise.all([
          client.invalidateQueries({
            queryKey: [mediaType === 'album' ? 'albums' : 'films'],
          }),
          client.invalidateQueries({ queryKey: ['imports'] }),
          client.invalidateQueries({ queryKey: ['lastfm-links'] }),
          client.invalidateQueries({ queryKey: ['album-picker'] }),
          client.invalidateQueries({ queryKey: [`${mediaType}-selection`] }),
          client.invalidateQueries({ queryKey: ['tags'] }),
        ])
      }
      await onAdded(id)
    },
  })
  const busy = disabled || search.isPending || add.isPending
  useEffect(() => {
    onPendingChange?.(add.isPending)
  }, [add.isPending, onPendingChange])

  function find(page = 1) {
    if (busy || !query.trim()) return
    add.reset()
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
      {search.data && !search.isPending && (
        <>
          {search.data.items.length === 0 ? (
            <p role="status">
              No matching {mediaType === 'album' ? 'albums' : 'films'}.
            </p>
          ) : (
            <ul
              className="manual-add-results"
              aria-label={`${provider} results`}
            >
              {search.data.items.map((item) => {
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
                      onClick={() => add.mutate(item)}
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
          {(search.data.page > 1 || search.data.hasMore) && (
            <div className="manual-add-pagination">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || search.data.page <= 1}
                onClick={() => find((search.data?.page ?? 1) - 1)}
              >
                Previous
              </Button>
              <span>Page {search.data.page}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={
                  busy || !search.data.hasMore || search.data.page >= 50
                }
                onClick={() => find((search.data?.page ?? 1) + 1)}
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
