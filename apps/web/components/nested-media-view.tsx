'use client'

import { useEffect, useState, type ReactNode, type UIEvent } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
import { TableScroll } from '@repo/ui/components/ui/table'
import { parseBrowseView, type BrowseView } from '@/utils/media-grid'
import type { DetailTarget } from '@/utils/detail-inspector'
import { BrowseViewSwitch } from './browse-controls'
import { DetailLink } from './detail-link'
import MediaArtwork from './media-artwork'

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

export function NestedMediaViewControls<Key extends string>({
  view,
  onViewChange,
  sortBy,
  direction,
  sortOptions,
  onSortChange,
  onDirectionChange,
  filters,
}: {
  view: BrowseView
  onViewChange: (view: BrowseView) => void
  sortBy: Key
  direction: 'asc' | 'desc'
  sortOptions: readonly { key: Key; label: string }[]
  onSortChange: (key: Key) => void
  onDirectionChange: (direction: 'asc' | 'desc') => void
  filters?: ReactNode
}) {
  const nextDirection = direction === 'asc' ? 'desc' : 'asc'
  const directionLabel =
    nextDirection === 'asc' ? 'Sort ascending' : 'Sort descending'
  return (
    <div className="nested-media-controls">
      <BrowseViewSwitch
        view={view}
        onChange={onViewChange}
        listLabel="Details view"
      />
      {view !== 'table' && (
        <>
          <div className="nested-media-sort">
            <select
              aria-label="Sort by"
              value={sortBy}
              onChange={(event) => {
                const option = sortOptions.find(
                  ({ key }) => key === event.target.value,
                )
                if (option) onSortChange(option.key)
              }}
            >
              {sortOptions.map(({ key, label }) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-7 p-0"
              aria-label={directionLabel}
              title={directionLabel}
              onClick={() => onDirectionChange(nextDirection)}
            >
              {direction === 'asc' ? (
                <ArrowUp size={14} />
              ) : (
                <ArrowDown size={14} />
              )}
            </Button>
          </div>
          {filters}
        </>
      )}
    </div>
  )
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
  return (
    <TableScroll
      ref={window.scroller}
      onScroll={window.onScroll}
      className={`nested-media-scroll ${className}`}
      role="region"
      aria-label={label}
      aria-busy={busy}
      data-inspector-scroll=""
    >
      {window.height ? (
        <div
          className="nested-media-extent"
          role="list"
          style={{ height: window.height - window.gap }}
        >
          <div
            className="nested-media-slots"
            role="presentation"
            style={{
              top: window.padTop,
              gridTemplateColumns: `repeat(${window.columns}, minmax(0, 1fr))`,
              gridAutoRows: window.rowHeight - window.gap,
              gap: window.gap,
            }}
          >
            {window.slots.map(({ index, item }) =>
              item == null ? (
                <div
                  key={index}
                  className="nested-media-card virtual-browse-placeholder"
                  data-view={view}
                  data-media-type={mediaType}
                  aria-hidden="true"
                >
                  <div className="nested-media-artwork virtual-browse-shimmer" />
                  <div className="nested-media-summary">
                    <div className="virtual-browse-line virtual-browse-shimmer" />
                    <div className="virtual-browse-line virtual-browse-line-short virtual-browse-shimmer" />
                  </div>
                </div>
              ) : (
                <div
                  key={index}
                  className="nested-media-item"
                  role="listitem"
                  aria-posinset={index + 1}
                  aria-setsize={
                    window.hasTotal === false ? undefined : window.total
                  }
                >
                  {renderItem(item, index)}
                </div>
              ),
            )}
          </div>
        </div>
      ) : (
        empty && (
          <div className="nested-media-empty" role="status">
            {empty}
          </div>
        )
      )}
    </TableScroll>
  )
}

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
  return (
    <article
      className="nested-media-card"
      data-view={view}
      data-media-type={mediaType}
    >
      <DetailLink
        className="nested-media-artwork"
        kind={kind}
        id={id}
        tabIndex={-1}
        aria-hidden="true"
      >
        <MediaArtwork
          alt=""
          src={artworkUrl}
          fallbackLabel={view === 'grid' ? 'No artwork' : ''}
          containerClassName="nested-media-image-container"
          imageClassName="nested-media-image"
          fallbackClassName="nested-media-image"
        />
      </DetailLink>
      <div className="nested-media-summary">
        <DetailLink
          className="nested-media-title"
          kind={kind}
          id={id}
          title={title}
        >
          {title}
        </DetailLink>
        {subtitle && <div className="nested-media-line">{subtitle}</div>}
        {(metadata || actions) && (
          <div className="nested-media-byline">
            {metadata && <div className="nested-media-line">{metadata}</div>}
            {actions && <div className="nested-media-actions">{actions}</div>}
          </div>
        )}
      </div>
    </article>
  )
}
