'use client'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  Cog,
  Download,
  LayoutGrid,
  ListChecks,
  SquarePlay,
  Tag,
  Users,
} from 'lucide-react'
import { scopedHref } from '@/utils/media-scope'
import { useLibrary, useMediaScope } from './media-scope'

const items = [
  { href: '/browse', label: 'Browse', Icon: LayoutGrid },
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
  const library = useLibrary()
  if (library === 'youtube')
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
        const destination =
          item.href === '/browse'
            ? scope === 'album'
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
