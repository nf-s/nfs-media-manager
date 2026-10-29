'use client'

import { useDeferredValue, useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { TagDetailSchema, TagPageSchema, type Tag } from '@repo/schemas/tags'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import MetadataSourceList from './metadata-source-list'
import TagActions from './tag-actions'

function TagManagement({ tag }: { tag: Tag }) {
  const { apiBaseUrl } = useConfig()
  const [search, setSearch] = useState('')
  const query = useDeferredValue(search.trim())
  const [candidate, setCandidate] = useState<Tag | null>(null)
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<{
    message: string
    interrupted: boolean
  } | null>(null)
  const matches = useQuery({
    queryKey: ['tags', 'merge-search', tag.mediaType, query],
    enabled: query.length > 0,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/tags?${new URLSearchParams({ mediaType: tag.mediaType, q: query, visibility: 'all', size: '25' })}`,
        TagPageSchema,
        { signal },
      ),
  })
  return (
    <section className="space-y-3" aria-label="Manage tag">
      <h2 className="font-semibold">Manage tag</h2>
      <p className="quiet text-sm">
        {tag.hidden
          ? 'Hidden from normal browsing. Unhide to restore it.'
          : 'Hiding removes this tag from normal browsing, not its source data.'}
      </p>
      <label className="block text-sm">
        Find another tag to merge
        <Input
          aria-label="Find tag to merge"
          placeholder="Search tags..."
          value={search}
          maxLength={200}
          disabled={pending}
          onChange={(event) => {
            setSearch(event.target.value)
            setCandidate(null)
          }}
        />
      </label>
      {query && !candidate && (
        <div className="max-h-40 overflow-auto border text-sm">
          {matches.isPending && (
            <p className="p-2" role="status">
              Loading tags...
            </p>
          )}
          {matches.isError && (
            <p className="p-2" role="alert">
              Could not find tags.{' '}
              <button className="underline" onClick={() => matches.refetch()}>
                Retry
              </button>
            </p>
          )}
          {matches.data?.items
            .filter((item) => item.id !== tag.id)
            .map((item) => (
              <button
                type="button"
                key={item.id}
                className="block w-full px-2 py-1 text-left hover:bg-neutral-100"
                disabled={pending}
                onClick={() => setCandidate(item)}
              >
                {item.name}
                {item.hidden ? ' (hidden)' : ''}
              </button>
            ))}
          {matches.data &&
            !matches.data.items.some((item) => item.id !== tag.id) && (
              <p className="p-2">No other matching tags.</p>
            )}
          {matches.data &&
            matches.data.totalCount > matches.data.items.length && (
              <p className="quiet p-2 text-xs">
                Showing the first 25 matches. Refine the search to find a
                specific tag.
              </p>
            )}
        </div>
      )}
      {candidate && (
        <p className="text-sm">
          Merge with: <strong>{candidate.name}</strong>{' '}
          <button
            type="button"
            className="underline"
            disabled={pending}
            onClick={() => setCandidate(null)}
          >
            Remove
          </button>
        </p>
      )}
      <TagActions
        key={`${tag.id}:${candidate?.id ?? ''}`}
        tags={candidate ? [tag, candidate] : [tag]}
        onPendingChange={setPending}
        onComplete={(_ids, message, interrupted) => {
          setCandidate(null)
          setSearch('')
          setOutcome({ message, interrupted })
        }}
      />
      {outcome && (
        <p className="text-xs" role={outcome.interrupted ? 'alert' : 'status'}>
          {outcome.message}
        </p>
      )}
    </section>
  )
}

export default function TagDetailModal({
  id,
  mediaType,
  onClose,
}: {
  id: string
  mediaType: 'album' | 'film'
  onClose: () => void
}) {
  const { apiBaseUrl } = useConfig()
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const detail = useInfiniteQuery({
    queryKey: ['tag-detail', mediaType, id],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/tags/${encodeURIComponent(id)}?mediaType=${mediaType}&page=${pageParam}&size=100`,
        TagDetailSchema,
        { signal },
      ),
    getNextPageParam: (last) =>
      last.provenance.page < last.provenance.pageCount
        ? last.provenance.page + 1
        : undefined,
  })
  const data = detail.data?.pages[0]
  useEffect(() => {
    const element = dialog.current
    const previous = document.activeElement
    if (!element?.open) element?.showModal()
    return () => {
      element?.close()
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true })
    }
  }, [])
  return (
    <dialog
      ref={dialog}
      className="media-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (event.target === event.currentTarget) onClose()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="detail-dialog-inner">
        <div className="detail-topbar">
          <span>Tag details</span>
          <button
            type="button"
            aria-label="Close tag details"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <h1 id={titleId} className="mb-2 text-2xl font-semibold">
          {data?.tag.name ?? 'Tag details'}
        </h1>
        {detail.isPending && <p role="status">Loading tag details...</p>}
        {detail.isError && (
          <p role="alert">
            Could not load tag details.{' '}
            <button
              className="underline"
              onClick={() =>
                detail.isFetchNextPageError
                  ? detail.fetchNextPage()
                  : detail.refetch()
              }
            >
              Retry
            </button>
          </p>
        )}
        {data && (
          <div className="space-y-6">
            <p className="quiet text-sm">
              {data.tag.mediaCount.toLocaleString()} items ·{' '}
              {data.tag.sourceCount.toLocaleString()} sources
              {data.tag.hidden ? ' · Hidden' : ''}
            </p>
            <div className="flex flex-wrap gap-3 text-sm">
              <Link
                className="underline"
                href={`/${data.tag.mediaType === 'album' ? 'albums' : 'films'}?${new URLSearchParams({ filters: JSON.stringify([{ field: 'genre', value: data.tag.name }]) })}`}
              >
                Browse {data.tag.mediaType === 'album' ? 'albums' : 'films'}{' '}
                with this tag
              </Link>
            </div>
            <TagManagement key={data.tag.id} tag={data.tag} />
            <section>
              <h2 className="mb-2 font-semibold">Merged names</h2>
              {data.aliases.length ? (
                <ul className="flex flex-wrap gap-2">
                  {data.aliases.map((alias) => (
                    <li key={alias.id} className="metadata-tag">
                      {alias.name}{' '}
                      <span className="quiet text-xs">({alias.kind})</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="quiet text-sm">No merged aliases.</p>
              )}
            </section>
            <section>
              <h2 className="mb-3 font-semibold">Detailed provenance</h2>
              <MetadataSourceList
                items={
                  detail.data?.pages.flatMap((page) => page.provenance.items) ??
                  []
                }
              />
              {data.provenance.totalCount === 0 && (
                <p className="quiet text-sm">
                  No original source metadata was saved for this tag.
                </p>
              )}
              {detail.hasNextPage && (
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  disabled={detail.isFetchingNextPage}
                  onClick={() => detail.fetchNextPage()}
                >
                  {detail.isFetchingNextPage ? 'Loading...' : 'More sources'}
                </Button>
              )}
            </section>
          </div>
        )}
      </div>
    </dialog>
  )
}
