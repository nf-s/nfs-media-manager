'use client'

import Link from 'next/link'
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import type { BrowseFilter } from '@repo/schemas/browse'
import { Art, ArtFallback, type ArtRatio } from '@repo/ui/components/ds/artwork'
import { Count, Pill, PillLabel, Pills } from '@repo/ui/components/ds/pill'
import { Button } from '@repo/ui/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@repo/ui/components/ui/tabs'
import { formatCount } from '@repo/ui/lib/format'
import { detailTab } from '@/utils/detail-inspector'
import {
  ratingDescription,
  ratingScore,
  safeRatingHref,
  type ProviderRating,
} from '@/utils/provider-ratings'
import { useDetailView } from './detail-inspector-context'
import { DetailLink } from './detail-link'

/** Artwork for a detail header; the fallback icon stands in when there is none. */
export function DetailArt({
  src,
  ratio,
  size,
  badge,
  fallback,
}: {
  src: string | null | undefined
  ratio?: ArtRatio
  size?: 'sm'
  /** A short label on the artwork, such as a video's length. */
  badge?: ReactNode
  fallback: ReactNode
}) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  return (
    <Art ratio={ratio} size={size} badge={badge}>
      {src && !failed ? (
        <img
          className="ds-artimg"
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <ArtFallback>{fallback}</ArtFallback>
      )}
    </Art>
  )
}

export type DetailTabItem<Tab extends string> = {
  value: Tab
  label: string
  count?: number
}

/**
 * The open tab, kept in the detail's URL state. The first tab is the default
 * and is left out of the URL; `aliases` maps older tab values so their links
 * still open, and `reset` lists view settings that belong to one tab.
 */
export function useDetailTab<Tab extends string>(
  tabs: readonly [Tab, ...Tab[]],
  {
    aliases,
    reset = [],
  }: {
    aliases?: Readonly<Record<string, Tab>>
    reset?: readonly string[]
  } = {},
) {
  const view = useDetailView()
  const tab = detailTab(view.params.get('tab'), tabs, aliases)
  function setTab(next: string) {
    const value = tabs.find((item) => item === next)
    if (!value || value === tab) return
    const params = new URLSearchParams(view.params)
    if (value === tabs[0]) params.delete('tab')
    else params.set('tab', value)
    for (const key of reset) params.delete(key)
    view.replace(params)
  }
  return { tab, setTab }
}

/** Underlined tabs below the detail header. Panels are `TabsContent` children. */
export function DetailTabs<Tab extends string>({
  label,
  tabs,
  value,
  onChange,
  children,
}: {
  label: string
  tabs: readonly DetailTabItem<Tab>[]
  value: Tab
  onChange: (value: string) => void
  children: ReactNode
}) {
  return (
    <Tabs value={value} onValueChange={onChange} className="dtl-tabs">
      <TabsList aria-label={label}>
        {tabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
            {tab.count !== undefined && <Count>{formatCount(tab.count)}</Count>}
          </TabsTrigger>
        ))}
      </TabsList>
      {children}
    </Tabs>
  )
}

/** The standalone page of an item: a link back to its list, then the detail. */
export function DetailPage({
  back,
  children,
}: {
  back: { href: string; label: string }
  children: ReactNode
}) {
  return (
    <div className="ds-page dtl-page">
      <Button asChild variant="link" className="dtl-back">
        <Link href={back.href}>
          <ArrowLeft className="ds-i" data-size="sm" aria-hidden="true" />
          {back.label}
        </Link>
      </Button>
      {children}
    </div>
  )
}

/** A value that filters its library when clicked, shown in its filter mode. */
export function FilterPill({
  label,
  title,
  mode,
  onClick,
  href,
}: {
  label: string
  title?: string
  /** The mode of the active filter on this value; none when it is not filtered. */
  mode?: BrowseFilter['mode']
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void
  href?: string
}) {
  return (
    <Pill asChild size="md" mode={mode}>
      {href ? (
        <Link href={href} title={title} prefetch={false}>
          <PillLabel>{label}</PillLabel>
        </Link>
      ) : (
        <button type="button" title={title} onClick={onClick}>
          <PillLabel>{label}</PillLabel>
        </button>
      )}
    </Pill>
  )
}

/** The provider's page for this item, as the last action of a detail header. */
export function OpenAtProvider({
  label,
  url,
  actionLabel,
}: {
  label: string
  url: string
  actionLabel?: string
}) {
  const href = safeRatingHref(url)
  if (!href) return null
  return (
    <Button asChild variant="ghost" size="md">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${actionLabel ?? `Open at ${label}`} (opens in a new tab)`}
      >
        {actionLabel ?? label}
        <ExternalLink className="ds-i" data-size="sm" aria-hidden="true" />
      </a>
    </Button>
  )
}

/** The short name of a rating's source: "Rate Your Music" rather than "RYM rating". */
export function ratingSource(rating: ProviderRating) {
  return rating.display.shortLabel ?? rating.label.replace(/ rating$/, '')
}

/** One small card per rating: score and source, with the vote count on hover. */
export function RatingCards({
  ratings,
}: {
  ratings: readonly ProviderRating[]
}) {
  const scored = ratings.filter((rating) => rating.score !== undefined)
  if (!scored.length) return null
  return (
    <div className="ds-ratings" role="list" aria-label="Ratings">
      {scored.map((rating) => {
        const href = safeRatingHref(rating.href)
        const content = (
          <>
            <b>{ratingScore(rating)}</b>
            <span>{ratingSource(rating)}</span>
          </>
        )
        return href ? (
          <a
            key={rating.key}
            role="listitem"
            className="ds-ratingcard"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            title={ratingDescription(rating)}
          >
            {content}
          </a>
        ) : (
          <div
            key={rating.key}
            role="listitem"
            className="ds-ratingcard"
            title={ratingDescription(rating)}
          >
            {content}
          </div>
        )
      })}
    </div>
  )
}

/** Playlists an item belongs to; each opens the playlist's drawer. */
export function PlaylistPills({
  playlists,
}: {
  playlists: readonly { id: string; name: string; title?: string }[]
}) {
  if (!playlists.length)
    return <p className="ds-help">No playlist memberships.</p>
  return (
    <Pills wrap label="Playlists">
      {playlists.map((playlist) => (
        <Pill asChild size="md" key={playlist.id}>
          <DetailLink
            kind="playlist"
            id={playlist.id}
            title={playlist.title ?? `Open ${playlist.name}`}
          >
            <PillLabel>{playlist.name}</PillLabel>
          </DetailLink>
        </Pill>
      ))}
    </Pills>
  )
}
