'use client'

import { useEffect, useState, type ReactNode, type UIEvent } from 'react'
import { Card, CardGrid, CardTitle } from '@repo/ui/components/ds/card'
import { List, ListRow, RowTitle } from '@repo/ui/components/ds/list-row'
import { Skeleton, State } from '@repo/ui/components/ds/feedback'
import { cardGrid, parseBrowseView, type BrowseView } from '@/utils/media-grid'
import type { DetailTarget } from '@/utils/detail-inspector'
import { DetailLink } from './detail-link'
import {
  MediaArt,
  MediaThumb,
  artworkRatio,
  type ArtworkKind,
} from './media-artwork'

type CardView = Exclude<BrowseView, 'table'>
type ArtworkType = 'album' | 'film' | 'subscription'

export function useNestedMediaView(
  scope: string,
  fallback: BrowseView = 'table',
) {
  const key = `nested-media-view:${scope}`
  const [saved, setSaved] = useState<{ key: string; view: BrowseView } | null>(
    null,
  )
  useEffect(() => {
    try {
      setSaved({
        key,
        view: parseBrowseView(window.localStorage.getItem(key), fallback),
      })
    } catch {
      // The view can still change when browser storage is unavailable.
    }
  }, [key, fallback])
  const view = saved?.key === key ? saved.view : fallback
  function changeView(view: BrowseView) {
    setSaved({ key, view })
    try {
      window.localStorage.setItem(key, view)
    } catch {
      // Keep the choice for this mount.
    }
  }
  return [view, changeView] satisfies [BrowseView, (view: BrowseView) => void]
}

export type NestedMediaWindow<Item> = {
  slots: readonly { index: number; item: Item | null | undefined }[]
  total: number
  hasTotal?: boolean
  padTop: number
  height: number
  rowHeight: number
  columns: number
  gap: number
  scroller: (element: HTMLDivElement | null) => void
  onScroll: (event: UIEvent<HTMLDivElement>) => void
}

/** The artwork shape and placeholder for an item kind in a nested list. */
function artworkKind(
  kind: DetailTarget['kind'],
  mediaType: ArtworkType,
): ArtworkKind {
  if (mediaType === 'subscription' || kind === 'subscription') return 'video'
  if (mediaType === 'film' || kind === 'film') return 'film'
  switch (kind) {
    case 'track':
    case 'playlist':
    case 'artist':
    case 'person':
      return kind
    default:
      return 'album'
  }
}

/**
 * A virtual window of nested items as cards or list rows. The window's
 * geometry comes from `useVirtualTable` with a `presentation`.
 */
export function NestedMediaCards<Item>({
  window,
  view,
  mediaType,
  label,
  empty,
  busy,
  renderItem,
  className = '',
}: {
  window: NestedMediaWindow<Item>
  view: CardView
  mediaType: ArtworkType
  label: string
  empty?: ReactNode
  busy?: boolean
  renderItem: (item: Item, index: number) => ReactNode
  className?: string
}) {
  const grid = view === 'grid'
  const placeholder = (index: number) =>
    grid ? (
      <div key={index} className="ds-card" aria-hidden="true">
        <span
          className="ds-art"
          data-ratio={artworkRatio(artworkKind('album', mediaType))}
        >
          <Skeleton width="100%" height="100%" />
        </span>
        <Skeleton height={12} width="80%" />
        <Skeleton height={10} width="55%" />
      </div>
    ) : (
      <div key={index} className="ds-row" aria-hidden="true">
        <Skeleton width={40} height={40} />
        <div className="ds-row-main">
          <Skeleton height={12} width="60%" />
          <Skeleton height={10} width="40%" />
        </div>
      </div>
    )
  const slots = window.slots.map(({ index, item }) =>
    item == null ? (
      placeholder(index)
    ) : (
      <div
        key={index}
        className="browse-nested-item"
        role="listitem"
        aria-posinset={index + 1}
        aria-setsize={window.hasTotal === false ? undefined : window.total}
      >
        {renderItem(item, index)}
      </div>
    ),
  )
  return (
    <div
      ref={window.scroller}
      onScroll={window.onScroll}
      className={`browse-scroller ${className}`.trim()}
      role="region"
      aria-label={label}
      aria-busy={busy}
      tabIndex={0}
      data-inspector-scroll=""
    >
      {window.height ? (
        <div
          className="browse-extent"
          role="list"
          style={{
            height: grid
              ? window.height -
                window.gap +
                cardGrid.paddingTop +
                cardGrid.paddingBottom
              : window.height,
          }}
        >
          {grid ? (
            <CardGrid
              className="browse-slots"
              role="presentation"
              style={{
                top: window.padTop,
                gridTemplateColumns: `repeat(${window.columns}, minmax(0, 1fr))`,
                gridAutoRows: window.rowHeight - window.gap,
                rowGap: window.gap,
              }}
            >
              {slots}
            </CardGrid>
          ) : (
            <List
              className="browse-slots"
              role="presentation"
              style={{ top: window.padTop }}
            >
              {slots}
            </List>
          )}
        </div>
      ) : (
        empty &&
        (typeof empty === 'string' ? (
          <State title={empty} size="sm" />
        ) : (
          <div className="ds-state" data-size="sm" role="status">
            {empty}
          </div>
        ))
      )}
    </div>
  )
}

/**
 * One nested item: a card in Grid, a 48px row in List. The artwork and
 * title open the item; `actions` holds its play pair.
 */
export function NestedMediaCard({
  view,
  kind,
  id,
  title,
  artworkUrl,
  mediaType = kind === 'film' || kind === 'subscription' ? kind : 'album',
  subtitle,
  metadata,
  actions,
}: DetailTarget & {
  view: CardView
  title: string
  artworkUrl?: string | null
  mediaType?: ArtworkType
  subtitle?: ReactNode
  metadata?: ReactNode
  actions?: ReactNode
}) {
  const artwork = artworkKind(kind, mediaType)
  const titleLink = (
    <DetailLink kind={kind} id={id} title={title}>
      {title}
    </DetailLink>
  )
  if (view === 'list')
    return (
      <ListRow
        thumb={
          <DetailLink
            className="browse-thumb-link"
            kind={kind}
            id={id}
            tabIndex={-1}
            aria-hidden="true"
          >
            <MediaThumb kind={artwork} src={artworkUrl} size={40} />
          </DetailLink>
        }
        title={<RowTitle>{titleLink}</RowTitle>}
        by={subtitle}
        play={
          actions ? (
            <span className="browse-row-actions">{actions}</span>
          ) : undefined
        }
        meta={metadata}
      />
    )
  return (
    <Card
      art={
        <MediaArt kind={artwork} src={artworkUrl}>
          {(image) => (
            <DetailLink
              className="browse-art-link"
              kind={kind}
              id={id}
              tabIndex={-1}
              aria-hidden="true"
            >
              {image}
            </DetailLink>
          )}
        </MediaArt>
      }
      title={<CardTitle>{titleLink}</CardTitle>}
      by={subtitle ?? ''}
      meta={metadata ?? ''}
      tags={
        actions ? (
          <span className="browse-card-actions">{actions}</span>
        ) : undefined
      }
    />
  )
}
