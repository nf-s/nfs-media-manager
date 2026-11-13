'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams } from 'next/navigation'
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowUp,
  CalendarRange,
  Grid2X2,
  Info,
  Rows3,
  Search,
  Timer,
  Users,
  X,
} from 'lucide-react'
import {
  YoutubeDurationSchema,
  YoutubeVideoPageSchema,
  YoutubeVideoSortSchema,
  youtubeVideoUrl,
  type YoutubeChannel,
  type YoutubeVideo,
  type YoutubeVideoSort,
} from '@repo/schemas/youtube'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { useConfig } from './providers'
import AiSearch from './ai-search'
import BrowseFilterPanel, { FilterPanelSection } from './browse-filter-panel'
import { FilterButton } from './filter-affordance'
import { ChannelAvatar, useYoutubeChannels } from './youtube-channels'
import { VideoThumbnail, YoutubeVideoDetails } from './youtube-video-details'
import { fetchApiData } from '@/utils/api'
import { aiYoutubeSearchParams, youtubeAiSearchTarget } from '@/utils/ai-search'
import { useInfiniteTableScroll } from '@/hooks/useInfiniteTableScroll'
import { useRailSlot } from '@/hooks/useRailSlot'
import {
  YOUTUBE_MAX_CHANNEL_FILTERS,
  formatCompactCount,
  formatYoutubeDay,
  hasYoutubeVideoFilters,
  parseYoutubeVideoState,
  updateYoutubeSearch,
  youtubeDurationLabel,
  youtubeDurationLabels,
  youtubeSortLabels,
  youtubeSortOptions,
  youtubeVideoSort,
  youtubeVideosPath,
} from '@/utils/youtube'
import styles from './youtube-videos.module.css'

const dayPattern = /^\d{4}-\d{2}-\d{2}$/
const searchFieldOptions: Array<{ value: 'all' | 'title'; label: string }> = [
  { value: 'all', label: 'Titles and descriptions' },
  { value: 'title', label: 'Titles only' },
]

function views(video: YoutubeVideo) {
  return video.viewCount === null
    ? 'Views hidden'
    : `${formatCompactCount(video.viewCount)} views`
}

function ExternalTitle({
  video,
  className,
}: {
  video: YoutubeVideo
  className?: string
}) {
  return (
    <a
      className={className}
      href={youtubeVideoUrl(video.id)}
      target="_blank"
      rel="noreferrer"
      title={video.title}
    >
      {video.title}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

function ChannelPicker({
  channels,
  selected,
  onChange,
}: {
  channels: ReturnType<typeof useYoutubeChannels>
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  const [filter, setFilter] = useState('')
  const needle = filter.trim().toLocaleLowerCase()
  const items = (channels.data?.items ?? []).filter(
    (channel) =>
      !needle ||
      channel.title.toLocaleLowerCase().includes(needle) ||
      channel.handle?.toLocaleLowerCase().includes(needle),
  )
  const full = selected.length >= YOUTUBE_MAX_CHANNEL_FILTERS
  return (
    <details className="toolbar-popover">
      <summary>
        <Users size={15} aria-hidden="true" /> Channels
        {selected.length ? ` (${selected.length})` : ''}
      </summary>
      <div className={`popover-panel ${styles.channelPanel}`}>
        <Input
          type="search"
          aria-label="Find channel"
          placeholder="Find channel"
          className="h-8 text-xs"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        {channels.isPending && (
          <p role="status" className="muted">
            Loading channels...
          </p>
        )}
        {channels.isError && (
          <p role="alert">
            Could not load channels.{' '}
            <button type="button" onClick={() => channels.refetch()}>
              Retry
            </button>
          </p>
        )}
        {channels.data && !items.length && (
          <p className="muted">
            {channels.data.items.length
              ? 'No channels match.'
              : 'No channels stored.'}
          </p>
        )}
        {items.length > 0 && (
          <div
            className={styles.channelOptions}
            role="group"
            aria-label="Channels"
          >
            {items.map((channel) => {
              const checked = selected.includes(channel.id)
              return (
                <label className={styles.channelOption} key={channel.id}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && full}
                    onChange={(event) =>
                      onChange(
                        event.target.checked
                          ? [...selected, channel.id]
                          : selected.filter((id) => id !== channel.id),
                      )
                    }
                  />
                  <ChannelAvatar src={channel.thumbnailUrl} />
                  <span title={channel.title}>{channel.title}</span>
                  <span
                    className={styles.count}
                    title={`${channel.storedVideos.toLocaleString()} stored videos`}
                  >
                    {channel.storedVideos.toLocaleString()}
                  </span>
                </label>
              )
            })}
          </div>
        )}
        {full && (
          <p className="muted">
            Up to {YOUTUBE_MAX_CHANNEL_FILTERS} channels at a time.
          </p>
        )}
        {selected.length > 0 && (
          <button
            type="button"
            className="clear-filters justify-self-start"
            onClick={() => onChange([])}
          >
            Clear channels
          </button>
        )}
      </div>
    </details>
  )
}

function VideoTile({
  video,
  selected,
  onChannel,
  onDetails,
}: {
  video: YoutubeVideo
  selected: boolean
  onChannel: (channelId: string) => void
  onDetails: (trigger: HTMLElement) => void
}) {
  return (
    <article className={styles.tile} data-selected={selected}>
      <VideoThumbnail video={video} />
      <div className={styles.tileBody}>
        <ChannelAvatar src={video.channelThumbnailUrl} />
        <div className="min-w-0">
          <ExternalTitle video={video} className={styles.title} />
          <button
            type="button"
            className={styles.channel}
            title={`Filter to ${video.channelTitle}`}
            onClick={() => onChannel(video.channelId)}
          >
            {video.channelTitle}
          </button>
          <div className={styles.meta}>
            {views(video)} ·{' '}
            <time dateTime={video.publishedAt}>
              {new Date(video.publishedAt).toLocaleDateString()}
            </time>
          </div>
        </div>
        <button
          type="button"
          className={styles.detailsButton}
          aria-label={`Details for ${video.title}`}
          aria-haspopup="dialog"
          onClick={(event) => onDetails(event.currentTarget)}
        >
          <Info size={15} />
        </button>
      </div>
    </article>
  )
}

function SortHead({
  label,
  sort,
  current,
  direction,
  numeric = false,
  onSort,
}: {
  label: string
  sort: YoutubeVideoSort
  current: YoutubeVideoSort
  direction: 'asc' | 'desc'
  numeric?: boolean
  onSort: (sort: YoutubeVideoSort) => void
}) {
  const active = current === sort
  return (
    <th
      scope="col"
      className={numeric ? 'numeric' : undefined}
      aria-sort={
        active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'
      }
    >
      <button type="button" onClick={() => onSort(sort)}>
        {label}
        {active ? (direction === 'asc' ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  )
}

function channelTitle(
  id: string,
  channels: YoutubeChannel[],
  videos: YoutubeVideo[],
) {
  return (
    channels.find((channel) => channel.id === id)?.title ??
    videos.find((video) => video.channelId === id)?.channelTitle ??
    'Unknown channel'
  )
}

export default function YoutubeVideos() {
  const { apiBaseUrl } = useConfig()
  const search = useSearchParams()
  const state = parseYoutubeVideoState(search)
  const sortBy = youtubeVideoSort(state)
  const direction = sortBy === 'relevance' ? 'desc' : state.sortDirection
  const selectedId = search.get('video')
  const [draft, setDraft] = useState(state.q)
  const writtenQuery = useRef(state.q)
  const browser = useRef<HTMLElement>(null)
  const inspector = useRef<HTMLElement>(null)
  const detailTrigger = useRef<HTMLElement | null>(null)
  const openedHere = useRef(false)
  const railSlot = useRailSlot()
  const channels = useYoutubeChannels()

  function setParams(
    updates: Record<string, string | string[] | null>,
    push = false,
  ) {
    const params = updateYoutubeSearch(window.location.search, updates)
    const url = `${window.location.pathname}${params ? `?${params}` : ''}`
    if (push) window.history.pushState(null, '', url)
    else window.history.replaceState(null, '', url)
  }
  function filterToChannel(channelId: string) {
    openedHere.current = false
    setParams({ channelId: [channelId] })
  }
  function sort(next: YoutubeVideoSort) {
    setParams({
      sortBy: next,
      sortDirection: sortBy === next && direction === 'desc' ? 'asc' : null,
    })
  }
  function openDetail(id: string, trigger: HTMLElement) {
    detailTrigger.current = trigger
    openedHere.current = true
    setParams({ video: id }, true)
  }
  function closeDetail() {
    if (openedHere.current) {
      openedHere.current = false
      window.history.back()
    } else setParams({ video: null })
  }
  function clearFilters() {
    setParams({
      q: null,
      fields: null,
      channelId: null,
      duration: null,
      publishedFrom: null,
      publishedTo: null,
    })
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      // A longer AI request stays in the box; the search keeps the first 200 characters.
      const next = draft.trim().slice(0, 200)
      if (next === writtenQuery.current) return
      writtenQuery.current = next
      const params = updateYoutubeSearch(window.location.search, {
        q: next || null,
      })
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${params ? `?${params}` : ''}`,
      )
    }, 250)
    return () => window.clearTimeout(timer)
  }, [draft])
  useEffect(() => {
    // Chips, Clear all and history navigation change the search outside the input.
    if (state.q === writtenQuery.current) return
    writtenQuery.current = state.q
    setDraft(state.q)
  }, [state.q])

  const firstPage = youtubeVideosPath(state, 1)
  const videos = useInfiniteQuery({
    queryKey: ['youtube-videos', firstPage],
    initialPageParam: 1,
    placeholderData: keepPreviousData,
    queryFn: ({ pageParam, signal }) =>
      fetchApiData(
        apiBaseUrl,
        youtubeVideosPath(state, pageParam),
        YoutubeVideoPageSchema,
        { signal },
      ),
    getNextPageParam: (last) =>
      last.page < last.pageCount ? last.page + 1 : undefined,
  })
  const { scroller, sentinel } = useInfiniteTableScroll({
    enabled: videos.hasNextPage && !videos.isFetching && !videos.isError,
    fetchNextPage: videos.fetchNextPage,
    resetKey: JSON.stringify([firstPage, state.view]),
  })
  // A sync that stores videos between page requests shifts later pages, which
  // can then repeat a video.
  const loaded = new Map<string, YoutubeVideo>()
  for (const page of videos.data?.pages ?? [])
    for (const video of page.items) loaded.set(video.id, video)
  const items = [...loaded.values()]
  const total = videos.data?.pages[0]?.totalCount ?? 0
  const selectedVideo = selectedId
    ? items.find((video) => video.id === selectedId)
    : undefined
  const selectedVideoId = selectedVideo?.id
  const filtered = hasYoutubeVideoFilters(state)
  const updating =
    videos.isPlaceholderData || draft.trim().slice(0, 200) !== state.q
  // Leaves out the search text, which is applied as it is typed: writing the
  // typed request must not cancel the AI search it starts.
  const aiQueryIdentity = JSON.stringify([
    state.fields,
    state.channelIds,
    state.duration,
    state.publishedFrom,
    state.publishedTo,
    state.sortBy,
    state.sortDirection,
  ])

  useEffect(() => {
    if (selectedVideoId) inspector.current?.focus({ preventScroll: true })
    else if (detailTrigger.current?.isConnected)
      detailTrigger.current.focus({ preventScroll: true })
  }, [selectedVideoId])
  useEffect(() => {
    function openPopovers() {
      return [
        ...(browser.current?.querySelectorAll<HTMLDetailsElement>(
          '.toolbar-popover[open]',
        ) ?? []),
      ]
    }
    function onPointerDown(event: PointerEvent) {
      for (const popover of openPopovers())
        if (!(event.target instanceof Node && popover.contains(event.target)))
          popover.open = false
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.key !== 'Escape') return
      const popovers = openPopovers()
      if (popovers.length) {
        for (const popover of popovers) {
          popover.open = false
          popover.querySelector('summary')?.focus()
        }
        event.preventDefault()
      } else if (selectedVideo && !document.querySelector('dialog[open]')) {
        event.preventDefault()
        closeDetail()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  })

  const channelList = channels.data?.items ?? []
  const chips: Array<{ key: string; label: string; onRemove: () => void }> = [
    ...(state.q
      ? [
          {
            key: 'q',
            label: `Search: ${state.q}`,
            onRemove: () => setParams({ q: null }),
          },
        ]
      : []),
    ...(state.fields === 'title'
      ? [
          {
            key: 'fields',
            label: 'Titles only',
            onRemove: () => setParams({ fields: null }),
          },
        ]
      : []),
    ...state.channelIds.map((id) => ({
      key: `channel:${id}`,
      label: `Channel: ${channelTitle(id, channelList, items)}`,
      onRemove: () =>
        setParams({
          channelId: state.channelIds.filter((channel) => channel !== id),
        }),
    })),
    ...(state.duration
      ? [
          {
            key: 'duration',
            label: youtubeDurationLabels[state.duration],
            onRemove: () => setParams({ duration: null }),
          },
        ]
      : []),
    ...(state.publishedFrom || state.publishedTo
      ? [
          {
            key: 'published',
            label: `Published: ${state.publishedFrom ? formatYoutubeDay(state.publishedFrom) : '*'} to ${state.publishedTo ? formatYoutubeDay(state.publishedTo) : '*'}`,
            onRemove: () =>
              setParams({ publishedFrom: null, publishedTo: null }),
          },
        ]
      : []),
  ]
  const activeFilters = chips.length ? (
    <div className="active-filters">
      {chips.map((chip) => (
        <FilterButton
          key={chip.key}
          className="filter-pill"
          aria-label={`Remove filter: ${chip.label}`}
          onClick={chip.onRemove}
        >
          {chip.label} <X size={12} />
        </FilterButton>
      ))}
      <button className="clear-filters" onClick={clearFilters}>
        Clear all
      </button>
    </div>
  ) : null

  let results: ReactNode
  if (videos.isPending)
    results = (
      <div className="browse-empty" role="status">
        Loading videos...
      </div>
    )
  else if (videos.isError && !items.length)
    results = (
      <div className="browse-empty" role="alert">
        Could not load videos.{' '}
        <Button variant="outline" size="sm" onClick={() => videos.refetch()}>
          Retry
        </Button>
      </div>
    )
  else if (!items.length)
    results = filtered ? (
      <div className="browse-empty">
        No videos match.{' '}
        <button className="underline" onClick={clearFilters}>
          Clear filters
        </button>
      </div>
    ) : (
      <div className="browse-empty">
        No videos stored. Connect YouTube and run a sync in{' '}
        <Link className="underline" href="/youtube/subscriptions">
          Subscriptions
        </Link>
        .
      </div>
    )
  else if (state.view === 'grid')
    results = (
      <div className={styles.grid}>
        {items.map((video) => (
          <VideoTile
            key={video.id}
            video={video}
            selected={video.id === selectedId}
            onChannel={filterToChannel}
            onDetails={(trigger) => openDetail(video.id, trigger)}
          />
        ))}
      </div>
    )
  else
    results = (
      <table className={`compact-table ${styles.list}`} aria-label="Videos">
        <thead>
          <tr>
            <th scope="col" className={styles.listThumb}>
              <span className="sr-only">Thumbnail</span>
            </th>
            <th scope="col">Title</th>
            <th scope="col">Channel</th>
            <SortHead
              label="Published"
              sort="publishedAt"
              current={sortBy}
              direction={direction}
              onSort={sort}
            />
            <SortHead
              label="Duration"
              sort="durationSec"
              current={sortBy}
              direction={direction}
              numeric
              onSort={sort}
            />
            <SortHead
              label="Views"
              sort="viewCount"
              current={sortBy}
              direction={direction}
              numeric
              onSort={sort}
            />
            <th scope="col">
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((video) => (
            <tr key={video.id} data-selected={video.id === selectedId}>
              <td className={styles.listThumb}>
                <VideoThumbnail video={video} />
              </td>
              <td className={styles.listTitle}>
                <ExternalTitle video={video} />
              </td>
              <td>
                <button
                  type="button"
                  className={styles.channel}
                  title={`Filter to ${video.channelTitle}`}
                  onClick={() => filterToChannel(video.channelId)}
                >
                  {video.channelTitle}
                </button>
              </td>
              <td>
                <time dateTime={video.publishedAt}>
                  {new Date(video.publishedAt).toLocaleDateString()}
                </time>
              </td>
              <td className="numeric">{youtubeDurationLabel(video)}</td>
              <td className="numeric">{formatCompactCount(video.viewCount)}</td>
              <td>
                <button
                  type="button"
                  className={styles.detailsButton}
                  aria-label={`Details for ${video.title}`}
                  aria-haspopup="dialog"
                  onClick={(event) => openDetail(video.id, event.currentTarget)}
                >
                  <Info size={15} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )

  return (
    <section
      className="media-browser"
      aria-label="YouTube videos"
      ref={browser}
    >
      <div className="browse-main">
        <div className="browse-toolbar">
          <AiSearch
            target={youtubeAiSearchTarget}
            queryIdentity={aiQueryIdentity}
            autocomplete={{
              items: [],
              titlesLoading: false,
              titlesError: false,
              onOpenItem: () => undefined,
              options: [],
              textActionsOnly: true,
              placeholder: 'Search videos',
              value: draft,
              onValueChange: setDraft,
              onAddFilter: () => undefined,
              onApplyText: (value) => {
                writtenQuery.current = value.slice(0, 200)
                setParams({ q: writtenQuery.current || null })
              },
            }}
            onApply={(plan) => {
              writtenQuery.current = plan.q
              setDraft(plan.q)
              setParams(aiYoutubeSearchParams(plan))
            }}
          />
          <div className="browse-controls">
            <ChannelPicker
              channels={channels}
              selected={state.channelIds}
              onChange={(ids) => setParams({ channelId: ids })}
            />
            <select
              aria-label="Sort by"
              value={sortBy}
              onChange={(event) => {
                const parsed = YoutubeVideoSortSchema.safeParse(
                  event.target.value,
                )
                if (parsed.success)
                  setParams({ sortBy: parsed.data, sortDirection: null })
              }}
            >
              {youtubeSortOptions(state.q).map((option) => (
                <option key={option} value={option}>
                  {youtubeSortLabels[option]}
                </option>
              ))}
            </select>
            {sortBy !== 'relevance' && (
              <Button
                variant="ghost"
                className="icon-button"
                aria-label={
                  direction === 'desc' ? 'Sort ascending' : 'Sort descending'
                }
                onClick={() =>
                  setParams({
                    sortBy,
                    sortDirection: direction === 'desc' ? 'asc' : null,
                  })
                }
              >
                {direction === 'desc' ? (
                  <ArrowDown size={16} />
                ) : (
                  <ArrowUp size={16} />
                )}
              </Button>
            )}
            <BrowseFilterPanel count={chips.length}>
              {activeFilters && (
                <section
                  className="filter-panel-active"
                  aria-label="Active filters"
                >
                  <h3>Active filters</h3>
                  {activeFilters}
                </section>
              )}
              <FilterPanelSection
                title="Search"
                icon={<Search size={16} />}
                count={state.fields === 'title' ? 1 : 0}
                defaultOpen
              >
                <fieldset className="filter-panel-fields">
                  <legend className="sr-only">Search in</legend>
                  {searchFieldOptions.map(({ value, label }) => (
                    <label className="check-label" key={value}>
                      <input
                        type="radio"
                        name="youtube-search-fields"
                        checked={state.fields === value}
                        onChange={() =>
                          setParams({ fields: value === 'all' ? null : value })
                        }
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
              </FilterPanelSection>
              <FilterPanelSection
                title="Duration"
                icon={<Timer size={16} />}
                count={state.duration ? 1 : 0}
                defaultOpen
              >
                <div className="filter-panel-fields">
                  <label>
                    Length
                    <select
                      aria-label="Duration"
                      value={state.duration ?? ''}
                      onChange={(event) => {
                        const parsed = YoutubeDurationSchema.safeParse(
                          event.target.value,
                        )
                        setParams({
                          duration: parsed.success ? parsed.data : null,
                        })
                      }}
                    >
                      <option value="">Any</option>
                      {YoutubeDurationSchema.options.map((value) => (
                        <option key={value} value={value}>
                          {youtubeDurationLabels[value]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </FilterPanelSection>
              <FilterPanelSection
                title="Published"
                icon={<CalendarRange size={16} />}
                count={state.publishedFrom || state.publishedTo ? 1 : 0}
                defaultOpen
              >
                <div className={`range-editor ${styles.dateInputs}`}>
                  <div className="range-inputs">
                    {[
                      {
                        key: 'publishedFrom',
                        label: 'From',
                        value: state.publishedFrom,
                      },
                      {
                        key: 'publishedTo',
                        label: 'To',
                        value: state.publishedTo,
                      },
                    ].map(({ key, label, value }) => (
                      <label key={key}>
                        {label}
                        <input
                          type="date"
                          value={value ?? ''}
                          onChange={(event) => {
                            const next = event.target.value
                            if (!next || dayPattern.test(next))
                              setParams({ [key]: next || null })
                          }}
                        />
                      </label>
                    ))}
                  </div>
                  {state.publishedFrom &&
                    state.publishedTo &&
                    state.publishedFrom > state.publishedTo && (
                      <p role="alert">From is after To.</p>
                    )}
                </div>
              </FilterPanelSection>
            </BrowseFilterPanel>
            <div className="view-switch">
              <Button
                variant={state.view === 'grid' ? 'default' : 'ghost'}
                aria-label="Grid view"
                aria-pressed={state.view === 'grid'}
                onClick={() => setParams({ view: null })}
              >
                <Grid2X2 size={16} />
              </Button>
              <Button
                variant={state.view === 'list' ? 'default' : 'ghost'}
                aria-label="List view"
                aria-pressed={state.view === 'list'}
                onClick={() => setParams({ view: 'list' })}
              >
                <Rows3 size={16} />
              </Button>
            </div>
            <span className="browse-count" aria-live="polite">
              {videos.isPending || updating
                ? 'Loading...'
                : `${total.toLocaleString()} ${total === 1 ? 'video' : 'videos'}`}
            </span>
          </div>
        </div>
        {railSlot && activeFilters
          ? createPortal(
              <>
                <h2 className="rail-heading">Filters</h2>
                {activeFilters}
              </>,
              railSlot,
            )
          : activeFilters}
        <div
          className="browse-scroll"
          data-view={state.view}
          ref={scroller}
          tabIndex={0}
          role="region"
          aria-label={`Videos ${state.view}`}
          aria-busy={videos.isFetching}
        >
          {videos.isError &&
            items.length > 0 &&
            !videos.isFetchNextPageError && (
              <p role="alert" className={styles.status}>
                Could not refresh videos.{' '}
                <button className="underline" onClick={() => videos.refetch()}>
                  Retry
                </button>
              </p>
            )}
          {results}
          <div ref={sentinel} className={styles.status}>
            {videos.isFetchingNextPage && (
              <p role="status" className="muted">
                Loading more videos...
              </p>
            )}
            {videos.isFetchNextPageError && (
              <p role="alert">
                Could not load more videos.{' '}
                <button
                  className="underline"
                  onClick={() => videos.fetchNextPage({ cancelRefetch: false })}
                >
                  Retry
                </button>
              </p>
            )}
          </div>
        </div>
      </div>
      {selectedVideo && (
        <YoutubeVideoDetails
          ref={inspector}
          video={selectedVideo}
          onClose={closeDetail}
          onChannel={filterToChannel}
        />
      )}
    </section>
  )
}
