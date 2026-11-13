'use client'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  Cog,
  Download,
  LayoutGrid,
  ListChecks,
  ListMusic,
  SquarePlay,
  Tag,
  Users,
} from 'lucide-react'
import { scopedHref } from '@/utils/media-scope'
import { useLibraryView, useMediaScope } from './media-scope'

const items = [
  { href: '/browse', label: 'Browse', Icon: LayoutGrid },
  { href: '/playlists', label: 'Playlists', Icon: ListMusic },
  { href: '/tags', label: 'Tags', Icon: Tag },
  { href: '/imports', label: 'Imports', Icon: Download },
  { href: '/jobs', label: 'Jobs', Icon: ListChecks },
  { href: '/providers', label: 'Providers', Icon: Cog },
]
const youtubeItems = [
  { href: '/youtube', label: 'Videos', Icon: SquarePlay },
  { href: '/youtube/subscriptions', label: 'Subscriptions', Icon: Users },
]
export default function AppNavigation() {
  const path = usePathname()
  const params = useSearchParams()
  const scope = useMediaScope()
  const view = useLibraryView()
  if (view === 'youtube')
    return (
      <nav className="app-navigation" aria-label="Main navigation">
        {youtubeItems.map((item) => (
          <Link
            href={
              path === item.href && params.size
                ? `${item.href}?${params}`
                : item.href
            }
            key={item.href}
            aria-current={path === item.href ? 'page' : undefined}
          >
            {item.label}
            <item.Icon size={16} aria-hidden="true" />
          </Link>
        ))}
      </nav>
    )
  return (
    <nav className="app-navigation" aria-label="Main navigation">
      {items.map((item) => {
        // Playlists hold tracks and albums; films have none.
        if (item.href === '/playlists' && scope !== 'album') return null
        const destination =
          item.href === '/browse'
            ? view === 'track'
              ? '/tracks'
              : scope === 'album'
                ? '/albums'
                : '/films'
            : item.href
        const active =
          path === destination || path.startsWith(`${destination}/`)
        const href =
          path === destination && params.size
            ? `${destination}?${params}`
            : destination
        return (
          <Link
            href={item.href === '/browse' ? href : scopedHref(href, scope)}
            key={item.href}
            aria-current={active ? 'page' : undefined}
          >
            {item.label}
            <item.Icon size={16} aria-hidden="true" />
          </Link>
        )
      })}
    </nav>
  )
}
