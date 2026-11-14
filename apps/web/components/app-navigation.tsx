'use client'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  Cog,
  Download,
  LayoutGrid,
  ListChecks,
  ListMusic,
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
/** `section` is the path prefix that marks the link active; scoped links carry `mediaType`. */
const subscriptionItems = [
  {
    href: '/subscriptions',
    section: null,
    scoped: false,
    label: 'Browse',
    Icon: LayoutGrid,
  },
  {
    href: '/subscriptions/channels',
    section: '/subscriptions/channels',
    scoped: false,
    label: 'Channels',
    Icon: Users,
  },
  {
    href: '/imports/youtube',
    section: '/imports',
    scoped: true,
    label: 'Imports',
    Icon: Download,
  },
  {
    href: '/jobs',
    section: '/jobs',
    scoped: true,
    label: 'Jobs',
    Icon: ListChecks,
  },
  {
    href: '/providers',
    section: '/providers',
    scoped: true,
    label: 'Providers',
    Icon: Cog,
  },
]

function isUnder(path: string, root: string) {
  return path === root || path.startsWith(`${root}/`)
}

export default function AppNavigation() {
  const path = usePathname()
  const params = useSearchParams()
  const scope = useMediaScope()
  const view = useLibraryView()
  if (view === 'subscription')
    return (
      <nav className="app-navigation" aria-label="Main navigation">
        {subscriptionItems.map((item) => {
          const active = item.section
            ? isUnder(path, item.section)
            : path === item.href
          const href =
            path === item.href && params.size
              ? `${item.href}?${params}`
              : item.href
          return (
            <Link
              href={item.scoped ? scopedHref(href, 'subscription') : href}
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
  return (
    <nav className="app-navigation" aria-label="Main navigation">
      {items.map((item) => {
        const destination =
          item.href === '/browse'
            ? view === 'track'
              ? '/tracks'
              : scope === 'album'
                ? '/albums'
                : '/films'
            : item.href === '/playlists' && scope === 'film'
              ? '/collections'
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
            {item.href === '/playlists' && scope === 'film'
              ? 'Collections'
              : item.label}
            <item.Icon size={16} aria-hidden="true" />
          </Link>
        )
      })}
    </nav>
  )
}
