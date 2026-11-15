'use client'

import { useDeferredValue, useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { X } from 'lucide-react'
import { TagDetailSchema, TagPageSchema, type Tag } from '@repo/schemas/tags'
import { Input } from '@repo/ui/components/ui/input'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { VirtualTagSources } from './metadata-source-list'
import { SecondaryTableScroll, SecondaryVirtualRows } from './secondary-table'
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
  const matches = useVirtualTable({
    queryKey: ['tags', 'merge-search', tag.mediaType, query],
    enabled: query.length > 0 && !candidate && !pending,
    pageSize: 25,
    headerHeight: 0,
    loadPage: (page, size, signal) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/tags?${new URLSearchParams({ mediaType: tag.mediaType, q: query, visibility: 'all', page: String(page), size: String(size) })}`,
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
      {query && !candidate && !pending && (
        <div>
          {matches.isError && (
            <p className="p-2" role="alert">
              Could not find tags.{' '}
              <button
                type="button"
                className="underline"
                onClick={matches.retry}
              >
                Retry
              </button>
            </p>
          )}
          <SecondaryTableScroll
            ref={matches.scroller}
            onScroll={matches.onScroll}
            className="max-h-40"
            role="region"
            aria-label="Tags to merge"
            aria-busy={matches.isFetching}
          >
            <table
              className="compact-table"
              aria-label="Tags to merge"
              aria-rowcount={matches.hasTotal ? matches.total : undefined}
            >
              <tbody>
                <SecondaryVirtualRows
                  window={matches}
                  colSpan={1}
                  renderRow={(item, index) => (
                    <tr key={item.id} aria-rowindex={index + 1}>
                      <td>
                        <button
                          type="button"
                          className="block w-full truncate text-left hover:underline"
                          disabled={pending || item.id === tag.id}
                          onClick={() => setCandidate(item)}
                        >
                          {item.name}
                          {item.hidden ? ' (hidden)' : ''}
                          {item.id === tag.id ? ' (current tag)' : ''}
                        </button>
                      </td>
                    </tr>
                  )}
                />
              </tbody>
            </table>
            {matches.hasTotal && !matches.total && (
              <p className="p-2">No matching tags.</p>
            )}
          </SecondaryTableScroll>
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
  const detail = useVirtualTable({
    queryKey: ['tag-detail', mediaType, id],
    loadPage: async (page, size, signal) => {
      const result = await fetchApiData(
        apiBaseUrl,
        `/api/v1/tags/${encodeURIComponent(id)}?${new URLSearchParams({ mediaType, page: String(page), size: String(size) })}`,
        TagDetailSchema,
        { signal },
      )
      return { ...result.provenance, summary: result }
    },
  })
  const data = detail.firstPage?.summary
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
      className="tag-drawer"
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
      <div className="tag-drawer-inner">
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
        <div className="tag-drawer-body">
          <h1 id={titleId}>{data?.tag.name ?? 'Tag details'}</h1>
          {detail.isError && (
            <p role="alert">
              Could not load tag details.{' '}
              <button className="underline" onClick={detail.retry}>
                Retry
              </button>
            </p>
          )}
          {data && (
            <div className="tag-drawer-sections">
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
            </div>
          )}
          <section>
            <h2 className="mb-3 font-semibold">Detailed provenance</h2>
            <VirtualTagSources query={detail} label="Detailed provenance" />
          </section>
        </div>
      </div>
    </dialog>
  )
}
