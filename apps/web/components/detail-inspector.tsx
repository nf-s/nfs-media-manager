'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useRef, type ComponentProps } from 'react'
import { ArrowLeft, X } from 'lucide-react'
import { MediaInspector } from './media-inspector'
import {
  InspectorEntryContext,
  useDetailInspector,
  useDetailView,
} from './detail-inspector-context'
import MediaDetail from './media-detail'
import TrackDetail from './track-detail'
import PlaylistDetail from './playlist-detail'
import { FilmCollectionEntries } from './film-collection-detail'
import { SubscriptionItemDetails } from './subscription-item-details'
import { ArtistDetail } from './artist-detail'
import { PersonDetail } from './person-detail'
import { ChannelDetail } from './channel-detail'
import {
  detailBrowseKind,
  detailPageHref,
  withoutDetailEntries,
  type DetailEntry,
} from '@/utils/detail-inspector'
import { parsePlaylistTab, type PlaylistTab } from '@/utils/playlist-links'

const labels = {
  album: 'Album details',
  film: 'Film details',
  track: 'Track details',
  playlist: 'Playlist details',
  subscription: 'Subscription details',
  collection: 'Film collection details',
  artist: 'Artist details',
  person: 'Person details',
  channel: 'Channel details',
}

type InspectorOptions = {
  media?: Omit<ComponentProps<typeof MediaDetail>, 'id' | 'mediaType'>
  track?: Pick<ComponentProps<typeof TrackDetail>, 'onFilter'>
  playlist?: Pick<ComponentProps<typeof PlaylistDetail>, 'filterTracks'>
  subscription?: Omit<ComponentProps<typeof SubscriptionItemDetails>, 'id'>
}

export function AppDetailInspector() {
  const pathname = usePathname()
  return detailBrowseKind(pathname) ? null : <DetailInspector />
}

/** The same frame serves the browse pages and workspaces outside Browse. */
export function DetailInspector(options: InspectorOptions) {
  const nav = useDetailInspector()
  const pathname = usePathname()
  const params = useSearchParams()
  const inspector = useRef<HTMLElement>(null)
  const scrollPositions = useRef(
    new Map<string, { content?: ScrollToOptions; table?: ScrollToOptions }>(),
  )
  const target = nav?.active
  const kind = target?.kind
  const id = target?.id
  const entryKey = nav?.entryKey

  useEffect(() => {
    if (id) inspector.current?.focus({ preventScroll: true })
  }, [kind, id])

  useEffect(() => {
    if (!entryKey || !id) return
    const previous = scrollPositions.current.get(entryKey)
    if (!previous) return
    // The table's own reset runs on mount before restoring its prior scroll.
    const frame = requestAnimationFrame(() => {
      const content = inspector.current?.querySelector('.inspector-scroll')
      const table = inspector.current?.querySelector('[data-inspector-scroll]')
      if (previous.content) content?.scrollTo(previous.content)
      if (previous.table) table?.scrollTo(previous.table)
    })
    return () => cancelAnimationFrame(frame)
  }, [entryKey, id])

  useEffect(() => {
    if (!nav?.active) return
    function onEscape(event: KeyboardEvent) {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        document.querySelector('dialog[open]')
      )
        return
      event.preventDefault()
      nav?.close()
    }
    document.addEventListener('keydown', onEscape)
    return () => document.removeEventListener('keydown', onEscape)
  }, [nav])

  if (!target || !nav) return null
  const { kind: activeKind } = target
  const pageParams =
    detailBrowseKind(pathname) === activeKind ||
    (pathname === `/${activeKind}s` &&
      !['artist', 'person', 'channel'].includes(activeKind))
      ? withoutDetailEntries(pathname, new URLSearchParams(params))
      : new URLSearchParams()
  const viewParams = new URLSearchParams(target.view)
  for (const key of new Set(viewParams.keys())) pageParams.delete(key)
  for (const [key, value] of viewParams) pageParams.append(key, value)

  return (
    <>
      <div className="inspector-backdrop" onClick={nav.close} />
      <MediaInspector
        ref={inspector}
        tabIndex={-1}
        aria-label={labels[activeKind]}
        onScrollCapture={(event) => {
          if (!(event.target instanceof HTMLElement)) return
          const area = event.target.matches('.inspector-scroll')
            ? 'content'
            : event.target.matches('[data-inspector-scroll]')
              ? 'table'
              : null
          if (!area) return
          const previous = scrollPositions.current.get(nav.entryKey)
          scrollPositions.current.set(nav.entryKey, {
            ...previous,
            [area]: {
              top: event.target.scrollTop,
              left: event.target.scrollLeft,
            },
          })
        }}
      >
        <div className="detail-topbar">
          <div className="flex items-center gap-3">
            {nav.canGoBack && (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-[var(--chip)]"
                onClick={nav.back}
              >
                <ArrowLeft size={14} aria-hidden="true" /> Back
              </button>
            )}
            <Link
              className="hover:underline"
              href={detailPageHref(target, pageParams)}
              prefetch={false}
            >
              Open page
            </Link>
          </div>
          <button type="button" aria-label="Close details" onClick={nav.close}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <InspectorEntryContext.Provider value={nav}>
          <InspectorContent
            key={nav.entryKey}
            target={target}
            options={options}
            onMerged={(id) => nav.replace({ kind: 'track', id })}
          />
        </InspectorEntryContext.Provider>
      </MediaInspector>
    </>
  )
}

function InspectorContent({
  target,
  options,
  onMerged,
}: {
  target: DetailEntry
  options: InspectorOptions
  onMerged: (id: string) => void
}) {
  if (target.kind === 'playlist' || target.kind === 'collection')
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-3.5 pb-3.5 pt-3">
        {target.kind === 'playlist' ? (
          <PlaylistInspectorContent id={target.id} {...options.playlist} />
        ) : (
          <FilmCollectionEntries id={target.id} />
        )}
      </div>
    )
  return (
    <div className="inspector-scroll">
      {target.kind === 'artist' ? (
        <ArtistDetail id={target.id} />
      ) : target.kind === 'person' ? (
        <PersonDetail id={target.id} />
      ) : target.kind === 'channel' ? (
        <ChannelDetail id={target.id} />
      ) : target.kind === 'track' ? (
        <TrackDetail id={target.id} {...options.track} onMerged={onMerged} />
      ) : target.kind === 'subscription' ? (
        <SubscriptionItemDetails id={target.id} {...options.subscription} />
      ) : (
        <MediaDetail
          mediaType={target.kind}
          id={target.id}
          {...options.media}
        />
      )}
    </div>
  )
}

export function PlaylistInspectorContent({
  id,
  filterTracks,
}: { id: string } & InspectorOptions['playlist']) {
  const detail = useDetailView()
  function onTabChange(tab: PlaylistTab) {
    if (tab === 'tracks') detail.params.delete('tab')
    else detail.params.set('tab', tab)
    detail.replace(detail.params)
  }
  return (
    <PlaylistDetail
      id={id}
      tab={parsePlaylistTab(detail.params.get('tab'))}
      onTabChange={onTabChange}
      filterTracks={filterTracks}
    />
  )
}
