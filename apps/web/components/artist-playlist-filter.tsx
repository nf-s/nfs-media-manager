'use client'

import { useDeferredValue, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { BrowseCountSchema } from '@repo/schemas/browse'
import { ArtistQuerySchema } from '@repo/schemas/creators'
import { PlaylistBrowsePageSchema } from '@repo/schemas/tracks'
import { Input } from '@repo/ui/components/ui/input'
import { useCountedVirtualTable } from '@/hooks/useVirtualTable'
import { fetchApiData } from '@/utils/api'
import { useDetailView } from './detail-inspector-context'
import { useConfig } from './providers'
import { SecondaryHeaderFilter } from './secondary-table'

const pageSize = 25

export function useArtistPlaylistFilter(disabled = false) {
  const view = useDetailView()
  const parsed = ArtistQuerySchema.shape.playlistIds.safeParse(
    view.params.get('playlistIds') ?? undefined,
  )
  const selected = parsed.success ? [...new Set(parsed.data)] : []

  function change(next: string[]) {
    if (disabled) return
    const params = new URLSearchParams(view.params)
    if (next.length) params.set('playlistIds', JSON.stringify(next))
    else params.delete('playlistIds')
    params.delete('page')
    view.replace(params)
  }

  return {
    filters: selected.length
      ? { playlistIds: JSON.stringify(selected) }
      : undefined,
    control: (
      <SecondaryHeaderFilter
        label="Playlists"
        active={selected.length > 0}
        disabled={disabled}
      >
        <ArtistPlaylistChoices
          selected={selected}
          onChange={change}
          disabled={disabled}
        />
      </SecondaryHeaderFilter>
    ),
  }
}

function ArtistPlaylistChoices({
  selected,
  onChange,
  disabled,
}: {
  selected: string[]
  onChange: (ids: string[]) => void
  disabled: boolean
}) {
  const { apiBaseUrl } = useConfig()
  const [search, setSearch] = useState('')
  const name = useDeferredValue(search.trim())
  const filters = name ? { name } : undefined
  const {
    window: choices,
    countError,
    retryCount,
  } = useCountedVirtualTable({
    queryKey: ['playlists', 'artist-filter', name],
    countKey: ['playlists', 'artist-filter-count', name],
    pageSize,
    rowHeight: 32,
    headerHeight: 0,
    loadCount: (signal) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/playlists/browse-count?${new URLSearchParams(filters)}`,
        BrowseCountSchema,
        { signal },
      ),
    loadPage: (page, size, signal) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/playlists/browse-page?${new URLSearchParams({
          ...filters,
          sortBy: 'name',
          direction: 'asc',
          page: String(page),
          size: String(size),
        })}`,
        PlaylistBrowsePageSchema,
        { signal },
      ),
  })
  const selectedNames = useQuery({
    queryKey: ['playlists', 'artist-filter-selected', selected],
    enabled: selected.length > 0,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/playlists/browse-page?${new URLSearchParams({
          ids: JSON.stringify(selected),
          size: String(selected.length),
        })}`,
        PlaylistBrowsePageSchema,
        { signal },
      ),
  })
  const names = new Map<string, string>()
  for (const { item } of choices.loadedSlots) names.set(item.id, item.name)
  for (const item of selectedNames.data?.items ?? [])
    names.set(item.id, item.name)
  const failed = choices.isError || countError

  return (
    <div className="grid w-64 max-w-full gap-2 text-sm">
      <Input
        type="search"
        aria-label="Search playlist filters"
        placeholder="Search playlists"
        className="h-7 text-xs"
        maxLength={200}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        disabled={disabled}
      />
      {selected.length > 0 && (
        <div
          className="flex max-h-28 flex-wrap gap-1 overflow-auto"
          aria-label="Selected playlists"
        >
          {selected.map((id) => {
            const title = names.get(id) ?? 'Selected playlist'
            return (
              <button
                key={id}
                type="button"
                className="filter-pill filter-required max-w-full"
                aria-label={`Remove playlist filter: ${title}`}
                title={title}
                disabled={disabled}
                onClick={() =>
                  onChange(selected.filter((value) => value !== id))
                }
              >
                <span className="truncate">{title}</span>
                <X size={12} className="shrink-0" aria-hidden="true" />
              </button>
            )
          })}
        </div>
      )}
      {selectedNames.isError && selected.length > 0 && (
        <p role="alert" className="quiet">
          Could not load selected playlist names.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => selectedNames.refetch()}
          >
            Retry
          </button>
        </p>
      )}
      {failed && (
        <p role="alert" className="quiet">
          Could not load playlists.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => {
              choices.retry()
              if (countError) retryCount()
            }}
          >
            Retry
          </button>
        </p>
      )}
      {choices.hasTotal && (
        <span className="quiet">
          {choices.total.toLocaleString()}{' '}
          {choices.total === 1 ? 'playlist' : 'playlists'}
        </span>
      )}
      {choices.hasTotal && choices.total === 0 ? (
        <p className="quiet">No matching playlists.</p>
      ) : (
        <div
          ref={choices.scroller}
          onScroll={choices.onScroll}
          className="max-h-[min(256px,40dvh)] overflow-auto overscroll-contain [overflow-anchor:none]"
          role="region"
          aria-label="Playlist filter choices"
          aria-busy={!choices.hasTotal || choices.isFetching}
          tabIndex={0}
          data-inspector-scroll=""
        >
          <ul className="grid">
            {choices.padTop > 0 && (
              <li aria-hidden="true" style={{ height: choices.padTop }} />
            )}
            {choices.slots.map(({ index, item }) =>
              item ? (
                <li
                  key={index}
                  style={{ height: choices.rowHeight }}
                  aria-posinset={index + 1}
                  aria-setsize={choices.hasTotal ? choices.total : undefined}
                >
                  <label
                    className="flex h-full min-w-0 items-center gap-2 px-1"
                    title={item.name}
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(item.id)}
                      disabled={
                        disabled ||
                        (selected.length >= 100 && !selected.includes(item.id))
                      }
                      onChange={(event) =>
                        onChange(
                          event.target.checked
                            ? [...selected, item.id]
                            : selected.filter((id) => id !== item.id),
                        )
                      }
                    />
                    <span className="truncate">{item.name}</span>
                  </label>
                </li>
              ) : (
                <li
                  key={index}
                  className="virtual-browse-placeholder"
                  aria-hidden="true"
                  style={{ height: choices.rowHeight }}
                >
                  <div className="virtual-browse-line virtual-browse-shimmer" />
                </li>
              ),
            )}
            {choices.padBottom > 0 && (
              <li aria-hidden="true" style={{ height: choices.padBottom }} />
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
