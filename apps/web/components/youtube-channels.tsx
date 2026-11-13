'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import {
  YoutubeChannelListSchema,
  type YoutubeChannel,
} from '@repo/schemas/youtube'
import { Input } from '@repo/ui/components/ui/input'
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScroll,
  TableState,
} from '@repo/ui/components/ui/table'
import { useConfig } from './providers'
import MediaArtwork from './media-artwork'
import { fetchApiData } from '@/utils/api'
import {
  filterYoutubeChannels,
  youtubeChannelColumns,
  youtubeChannelSort,
  youtubeChannelVideosHref,
  type YoutubeChannelSort,
} from '@/utils/youtube'
import styles from './youtube-videos.module.css'

export function useYoutubeChannels() {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: ['youtube-channels'],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/youtube/channels',
        YoutubeChannelListSchema,
      ),
  })
}

export function ChannelAvatar({
  src,
  size = 'small',
}: {
  src: string | null
  size?: 'small' | 'large'
}) {
  return (
    <MediaArtwork
      src={src}
      alt=""
      fallbackLabel=""
      containerClassName={`${styles.avatar} ${size === 'large' ? styles.avatarLarge : ''}`}
      imageClassName={styles.avatarImage ?? ''}
      fallbackClassName={styles.avatarImage ?? ''}
    />
  )
}

function ChannelRow({ channel }: { channel: YoutubeChannel }) {
  return (
    <TableRow>
      <TableCell>
        <span className={styles.channelCell}>
          <ChannelAvatar src={channel.thumbnailUrl} />
          <Link href={youtubeChannelVideosHref(channel.id)}>
            {channel.title}
          </Link>
        </span>
      </TableCell>
      <TableCell>{channel.handle ?? '-'}</TableCell>
      <TableCell className="numeric">
        {channel.subscriberCount === null
          ? 'Hidden'
          : channel.subscriberCount.toLocaleString()}
      </TableCell>
      <TableCell className="numeric">
        {channel.storedVideos.toLocaleString()}
        {!channel.historyComplete && (
          <div className="muted">Reading history</div>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {channel.latestVideoAt ? (
          <time dateTime={channel.latestVideoAt}>
            {new Date(channel.latestVideoAt).toLocaleDateString()}
          </time>
        ) : (
          '-'
        )}
      </TableCell>
    </TableRow>
  )
}

export default function YoutubeChannels() {
  const search = useSearchParams()
  const channels = useYoutubeChannels()
  const sortBy = youtubeChannelSort(search.get('sortBy'))
  const sortDirection = search.get('sortDirection') === 'desc' ? 'desc' : 'asc'
  const [draft, setDraft] = useState(search.get('q') ?? '')
  const [query, setQuery] = useState(search.get('q') ?? '')
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = draft.trim()
      setQuery(next)
      const params = new URLSearchParams(window.location.search)
      if (next) params.set('q', next)
      else params.delete('q')
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${params.size ? `?${params}` : ''}`,
      )
    }, 250)
    return () => window.clearTimeout(timer)
  }, [draft])
  function sort(key: YoutubeChannelSort) {
    const params = new URLSearchParams(window.location.search)
    params.set('sortBy', key)
    params.set(
      'sortDirection',
      sortBy === key && sortDirection === 'asc' ? 'desc' : 'asc',
    )
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}?${params}`,
    )
  }
  const all = channels.data?.items ?? []
  const items = filterYoutubeChannels(all, query, sortBy, sortDirection)
  // The table is the scroller and takes the height the sync panel leaves; a
  // table that grows inside the page scroller cannot be scrolled over.
  return (
    <section
      aria-labelledby="youtube-channels"
      className="flex min-h-80 flex-1 flex-col"
    >
      <h2 id="youtube-channels">Channels</h2>
      <div className="job-toolbar">
        <Input
          type="search"
          aria-label="Filter channels"
          placeholder="Filter channels"
          value={draft}
          maxLength={200}
          onChange={(event) => setDraft(event.target.value)}
        />
        <span className="muted">
          {query
            ? `${items.length.toLocaleString()} of ${all.length.toLocaleString()} channels`
            : `${all.length.toLocaleString()} channels`}
        </span>
      </div>
      <TableScroll
        className="tags-scroll min-h-0 flex-1"
        role="region"
        aria-label="Subscribed channels"
      >
        <table className="compact-table" aria-label="Subscribed channels">
          <TableHeader>
            <TableRow>
              {youtubeChannelColumns.map((column) => (
                <TableHead
                  key={column.key}
                  className={column.numeric ? 'numeric' : undefined}
                  aria-sort={
                    sortBy === column.key
                      ? sortDirection === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                >
                  <button type="button" onClick={() => sort(column.key)}>
                    {column.label}
                    {sortBy === column.key
                      ? sortDirection === 'asc'
                        ? ' ↑'
                        : ' ↓'
                      : ''}
                  </button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {!items.length && (
              <TableState
                colSpan={youtubeChannelColumns.length}
                error={channels.isError}
              >
                {channels.isPending
                  ? 'Loading channels...'
                  : channels.isError
                    ? 'Could not load channels.'
                    : all.length
                      ? 'No channels match.'
                      : 'No channels stored.'}
                {channels.isError && (
                  <button
                    type="button"
                    className="ml-1 underline"
                    onClick={() => channels.refetch()}
                  >
                    Retry
                  </button>
                )}
              </TableState>
            )}
            {items.map((channel) => (
              <ChannelRow key={channel.id} channel={channel} />
            ))}
          </TableBody>
        </table>
      </TableScroll>
    </section>
  )
}
