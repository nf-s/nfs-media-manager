'use client'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  Download,
  History,
  LayoutGrid,
  Layers,
  Library,
  ListChecks,
  ListMusic,
  Tag,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { Count } from '@repo/ui/components/ds/pill'
import {
  libraryImportsHome,
  libraryMatchesHref,
  scopedHref,
  type Library as LibraryName,
} from '@/utils/media-scope'
import {
  providerNeedsAttention,
  providerOverviewOptions,
} from '@/utils/provider-health'
import { useRailLibraryView } from './media-scope'
import { useConfig } from './providers'
import JobActivity from './job-activity'

type NavItem = {
  /** Destination without the current page's query. */
  href: string
  label: string
  Icon: LucideIcon
  /** Path prefix that marks the item current. */
  section: string
  /** Only the exact path marks the item current. */
  exact?: boolean
}

/** Each library's own pages. Jobs and Providers sit once, under System. */
export function libraryNavigation(view: LibraryName): NavItem[] {
  // Mixes has no Matches page.
  if (view === 'mix')
    return [
      {
        href: '/mixes',
        label: 'Browse',
        Icon: LayoutGrid,
        section: '/mixes',
        exact: true,
      },
      {
        href: '/mixes/shows',
        label: 'Shows',
        Icon: Users,
        section: '/mixes/shows',
      },
      {
        href: scopedHref(libraryImportsHome('mix'), 'mix'),
        label: 'Imports',
        Icon: Download,
        section: '/imports',
      },
    ]
  const matches = {
    href: libraryMatchesHref(view),
    label: 'Matches',
    Icon: ListChecks,
    section: libraryMatchesHref(view),
    exact: true,
  }
  if (view === 'track')
    return [
      {
        href: '/tracks',
        label: 'Browse',
        Icon: LayoutGrid,
        section: '/tracks',
      },
      matches,
      {
        href: '/tracks/changes',
        label: 'History',
        Icon: History,
        section: '/tracks/changes',
      },
      {
        href: scopedHref('/playlists', 'track'),
        label: 'Playlists',
        Icon: ListMusic,
        section: '/playlists',
      },
      {
        href: scopedHref('/imports', 'track'),
        label: 'Imports',
        Icon: Download,
        section: '/imports',
      },
    ]
  if (view === 'artist')
    return [
      {
        href: '/artists',
        label: 'Browse',
        Icon: LayoutGrid,
        section: '/artists',
      },
      matches,
    ]
  if (view === 'subscription')
    return [
      {
        href: '/subscriptions',
        label: 'Browse',
        Icon: LayoutGrid,
        section: '/subscriptions',
        exact: true,
      },
      matches,
      {
        href: '/subscriptions/channels',
        label: 'Channels',
        Icon: Users,
        section: '/subscriptions/channels',
      },
      {
        href: scopedHref('/imports/youtube', 'subscription'),
        label: 'Imports',
        Icon: Download,
        section: '/imports',
      },
    ]
  const film = view === 'film'
  return [
    {
      href: film ? '/films' : '/albums',
      label: 'Browse',
      Icon: LayoutGrid,
      section: film ? '/films' : '/albums',
    },
    matches,
    ...(film
      ? [
          {
            href: scopedHref('/people', 'film'),
            label: 'People',
            Icon: Users,
            section: '/people',
          },
        ]
      : []),
    ...(film
      ? []
      : [
          {
            href: scopedHref('/playlists', 'album'),
            label: 'Playlists',
            Icon: ListMusic,
            section: '/playlists',
          },
        ]),
    {
      href: scopedHref('/collections', view),
      label: 'Collections',
      Icon: Library,
      section: '/collections',
    },
    {
      href: scopedHref('/tags', view),
      label: 'Tags',
      Icon: Tag,
      section: '/tags',
    },
    {
      href: scopedHref('/imports', view),
      label: 'Imports',
      Icon: Download,
      section: '/imports',
    },
  ]
}

/** A library's own pages under its Browse path, which leave Browse unmarked. */
const libraryPages = ['matches', 'changes']

function isCurrent(path: string, item: Pick<NavItem, 'section' | 'exact'>) {
  return item.exact
    ? path === item.section
    : path === item.section ||
        (path.startsWith(`${item.section}/`) &&
          !libraryPages.some((page) => path === `${item.section}/${page}`))
}

function NavLink({
  item,
  path,
  params,
  children,
}: {
  item: NavItem
  path: string
  params: URLSearchParams
  children?: React.ReactNode
}) {
  const current = isCurrent(path, item)
  const destination = item.href.split('?')[0] ?? item.href
  // Choosing the open page again keeps its filters.
  const href =
    path === destination && params.size ? `${path}?${params}` : item.href
  return (
    <Link
      href={href}
      className="ds-nav-item"
      aria-current={current ? 'page' : undefined}
    >
      <item.Icon className="ds-i" aria-hidden="true" />
      <span>{item.label}</span>
      {children}
    </Link>
  )
}

function ProviderAttentionCount() {
  const { apiBaseUrl } = useConfig()
  const overview = useQuery(providerOverviewOptions(apiBaseUrl))
  const count =
    overview.data?.providers.filter(providerNeedsAttention).length ?? 0
  if (!count) return null
  return (
    <>
      <Count tone="danger">{count}</Count>
      <span className="sr-only">
        {count === 1 ? 'provider needs' : 'providers need'} attention
      </span>
    </>
  )
}

export default function AppNavigation() {
  const path = usePathname()
  const params = new URLSearchParams(useSearchParams())
  const view = useRailLibraryView()
  return (
    <nav className="shell-nav" aria-label="Main navigation">
      {libraryNavigation(view).map((item) => (
        <NavLink key={item.href} item={item} path={path} params={params} />
      ))}
      <div className="ds-rail-label shell-nav-label">System</div>
      <div className="shell-nav-row">
        <NavLink
          item={{
            href: view === 'track' ? scopedHref('/jobs', 'track') : '/jobs',
            label: 'Jobs',
            Icon: Activity,
            section: '/jobs',
          }}
          path={path}
          params={params}
        />
        <JobActivity />
      </div>
      <NavLink
        item={{
          href: '/providers',
          label: 'Providers',
          Icon: Layers,
          section: '/providers',
        }}
        path={path}
        params={params}
      >
        <ProviderAttentionCount />
      </NavLink>
    </nav>
  )
}
