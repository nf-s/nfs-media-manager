'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
} from 'react'
import { ChevronLeft, ChevronRight, Maximize2, X } from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
import { MediaInspector } from './media-inspector'
import { ResultLineSlot } from './result-line'
import {
  InspectorEntryContext,
  InspectorPageContext,
  useDetailInspector,
  useDetailView,
} from './detail-inspector-context'
import MediaDetail from './media-detail'
import TrackDetail from './track-detail'
import PlaylistDetail from './playlist-detail'
import { LibraryPlaylistDetail } from './library-playlist-detail'
import { CollectionEntries } from './collection-detail'
import { SubscriptionItemDetails } from './subscription-item-details'
import {
  SpotifyAlbumReferenceState,
  useSpotifyAlbumReference,
} from './spotify-album-reference-link'
import { ArtistDetail } from './artist-detail'
import { PersonDetail } from './person-detail'
import { ChannelDetail } from './channel-detail'
import { JobDetail } from './job-detail'
import { TagDetail } from './tag-detail-modal'
import UserPageClient from './pages/user-page-client'
import { libraryViewForPath } from '@/utils/media-scope'
import {
  detailBrowseKind,
  detailCrumbKey,
  detailCrumbTrail,
  detailKindNames,
  detailPageHref,
  parseTagDetailId,
  withoutDetailEntries,
  type DetailCrumb,
  type DetailEntry,
} from '@/utils/detail-inspector'
import { workspaceTabLinkProps } from '@/utils/workspace-tab-destination'
import { parsePlaylistTab, type PlaylistTab } from '@/utils/playlist-links'

/** Plain clicks step within the drawer; modified clicks follow the link. */
function followsLink(event: MouseEvent<HTMLAnchorElement>) {
  return (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.altKey ||
    event.ctrlKey ||
    event.shiftKey
  )
}

const labels = {
  album: 'Album details',
  'spotify-album-reference': 'Album details',
  film: 'Film details',
  track: 'Track details',
  playlist: 'Playlist details',
  'library-playlist': 'Playlist details',
  subscription: 'Subscription details',
  mix: 'Mix details',
  collection: 'Film collection details',
  artist: 'Artist details',
  person: 'Person details',
  channel: 'Channel details',
  show: 'Show details',
  job: 'Job details',
  user: 'User panel',
  tag: 'Tag details',
}

type InspectorOptions = {
  media?: Omit<ComponentProps<typeof MediaDetail>, 'id' | 'mediaType'>
  track?: Pick<ComponentProps<typeof TrackDetail>, 'onFilter' | 'filterHref'>
  playlist?: Pick<ComponentProps<typeof PlaylistDetail>, 'filterTracks'>
  subscription?: Omit<
    ComponentProps<typeof SubscriptionItemDetails>,
    'id' | 'library'
  >
  mix?: Omit<ComponentProps<typeof SubscriptionItemDetails>, 'id' | 'library'>
}

export function AppDetailInspector() {
  const pathname = usePathname()
  return detailBrowseKind(pathname) || pathname === '/tracks/matches' ? null : (
    <DetailInspector />
  )
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
  const [crumbs, setCrumbs] = useState<ReadonlyMap<string, DetailCrumb>>(
    () => new Map(),
  )
  const [moreSlot, setMoreSlot] = useState<HTMLSpanElement | null>(null)
  const activeKey = target ? detailCrumbKey(target) : ''
  const setCrumb = useCallback(
    (crumb: DetailCrumb) =>
      setCrumbs((previous) => {
        const known = previous.get(activeKey)
        if (known?.title === crumb.title && known.batchHref === crumb.batchHref)
          return previous
        return new Map(previous).set(activeKey, crumb)
      }),
    [activeKey],
  )

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
      !['artist', 'person', 'channel', 'show'].includes(activeKind))
      ? withoutDetailEntries(pathname, new URLSearchParams(params))
      : new URLSearchParams()
  const viewParams = new URLSearchParams(target.view)
  for (const key of new Set(viewParams.keys())) pageParams.delete(key)
  for (const [key, value] of viewParams) pageParams.append(key, value)
  if (activeKind === 'user')
    pageParams.set(
      'mediaType',
      libraryViewForPath(pathname, params.get('mediaType')),
    )
  const pageHref = detailPageHref(target, pageParams)
  const pageLabel = crumbs.get(activeKey)?.title ?? detailKindNames[activeKind]
  const trail = detailCrumbTrail(
    pathname,
    nav.entries,
    crumbs,
    params.get('mediaType'),
  )
  const entryPageHrefs = nav.entries.map((entry) =>
    detailPageHref(entry, new URLSearchParams(entry.view)),
  )

  return (
    <>
      <div className="inspector-backdrop" onClick={nav.close} />
      <MediaInspector
        ref={inspector}
        tabIndex={-1}
        aria-label={
          activeKind === 'collection' && target.mediaType === 'album'
            ? 'Album collection details'
            : labels[activeKind]
        }
        onDismiss={nav.close}
        headerClassName="ds-inspector-bar dtl-bar"
        header={
          <>
            <div className="dtl-bar-start">
              {nav.canGoBack && (
                <Button
                  variant="ghost"
                  icon
                  aria-label="Back"
                  title="Back"
                  onClick={nav.back}
                >
                  <ChevronLeft className="ds-i" aria-hidden="true" />
                </Button>
              )}
              <nav className="ds-crumbs dtl-crumbs" aria-label="Breadcrumb">
                {trail.map((step, index) =>
                  step.to === 'current' ? (
                    <b key={index} title={step.label} aria-current="page">
                      {step.label}
                    </b>
                  ) : (
                    <Fragment key={index}>
                      {step.to === 'href' ? (
                        <Link
                          href={step.href}
                          prefetch={false}
                          title={step.label}
                        >
                          {step.label}
                        </Link>
                      ) : (
                        <a
                          {...workspaceTabLinkProps(
                            step.to === 'entry'
                              ? (entryPageHrefs[step.index] ?? nav.closedHref)
                              : nav.closedHref,
                            step.label,
                          )}
                          href={
                            step.to === 'library'
                              ? nav.closedHref
                              : nav.hrefAt(step.index)
                          }
                          title={step.label}
                          onClick={(event) => {
                            if (followsLink(event)) return
                            event.preventDefault()
                            if (step.to === 'library') nav.close()
                            else nav.backTo(step.index)
                          }}
                        >
                          {step.label}
                        </a>
                      )}
                      <ChevronRight
                        className="ds-i"
                        data-size="sm"
                        aria-hidden="true"
                      />
                    </Fragment>
                  ),
                )}
              </nav>
            </div>
            <span className="dtl-bar-end">
              <Button asChild variant="ghost" className="dtl-bar-open">
                <Link
                  {...workspaceTabLinkProps(pageHref, pageLabel)}
                  href={pageHref}
                  prefetch={false}
                >
                  <Maximize2
                    className="ds-i"
                    data-size="sm"
                    aria-hidden="true"
                  />
                  Open page
                </Link>
              </Button>
              <span ref={setMoreSlot} className="dtl-bar-more" />
              <Button
                variant="ghost"
                icon
                aria-label="Close details"
                title="Close"
                onClick={nav.close}
              >
                <X className="ds-i" aria-hidden="true" />
              </Button>
            </span>
          </>
        }
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
        <InspectorEntryContext.Provider value={nav}>
          <InspectorPageContext.Provider
            value={{ pageHref, setCrumb, moreSlot }}
          >
            <InspectorContent
              key={nav.entryKey}
              target={target}
              options={options}
              onMerged={(id, tab) =>
                nav.replace({
                  kind: 'track',
                  id,
                  view: tab
                    ? new URLSearchParams({ tab }).toString()
                    : undefined,
                })
              }
            />
          </InspectorPageContext.Provider>
        </InspectorEntryContext.Provider>
        <ResultLineSlot place="panel" />
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
  onMerged: (id: string, tab?: 'sources') => void
}) {
  const tag = target.kind === 'tag' ? parseTagDetailId(target.id) : null
  return (
    <div className="inspector-scroll dtl-body">
      {target.kind === 'user' ? (
        <UserPageClient />
      ) : target.kind === 'job' ? (
        <JobDetail id={target.id} />
      ) : target.kind === 'tag' ? (
        tag && <TagDetail id={tag.id} mediaType={tag.mediaType} />
      ) : target.kind === 'playlist' ? (
        <PlaylistInspectorContent id={target.id} {...options.playlist} />
      ) : target.kind === 'library-playlist' ? (
        <LibraryPlaylistDetail id={target.id} />
      ) : target.kind === 'collection' ? (
        <CollectionEntries
          id={target.id}
          mediaType={target.mediaType ?? 'film'}
        />
      ) : target.kind === 'artist' ? (
        <ArtistDetail id={target.id} />
      ) : target.kind === 'person' ? (
        <PersonDetail id={target.id} />
      ) : target.kind === 'channel' ? (
        <ChannelDetail id={target.id} />
      ) : target.kind === 'show' ? (
        <ChannelDetail id={target.id} library="mixes" />
      ) : target.kind === 'track' ? (
        <TrackDetail id={target.id} {...options.track} onMerged={onMerged} />
      ) : target.kind === 'spotify-album-reference' ? (
        <SpotifyAlbumReferenceDetail target={target} />
      ) : target.kind === 'subscription' ? (
        <SubscriptionItemDetails id={target.id} {...options.subscription} />
      ) : target.kind === 'mix' ? (
        <SubscriptionItemDetails
          id={target.id}
          library="mixes"
          {...options.mix}
        />
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

function SpotifyAlbumReferenceDetail({ target }: { target: DetailEntry }) {
  const nav = useDetailInspector()
  const album = useSpotifyAlbumReference(target.id, target.spotifyAlbumId)
  const id = album.data?.mediaItemId
  useEffect(() => {
    if (id) nav?.replace({ kind: 'album', id }, target)
  }, [id, nav, target])
  return <SpotifyAlbumReferenceState album={album} />
}

export function PlaylistInspectorContent({
  id,
  filterTracks,
}: { id: string } & InspectorOptions['playlist']) {
  const detail = useDetailView()
  function onTabChange(tab: PlaylistTab) {
    const params = new URLSearchParams(detail.params)
    if (tab === 'overview') params.delete('tab')
    else params.set('tab', tab)
    detail.replace(params)
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
