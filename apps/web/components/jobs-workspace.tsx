'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { PageHead } from '@repo/ui/components/ds/toolbar'
import { metadataLibrary } from '@/utils/job-media-scope'
import { scopedHref, systemLibraryFilter } from '@/utils/media-scope'
import { useRailLibraryView } from './media-scope'

/** Jobs and Metadata share the Jobs heading and its tabs; job pages do not. */
export default function JobsWorkspace({
  children,
}: {
  children: React.ReactNode
}) {
  const path = usePathname()
  const params = useSearchParams()
  const rail = useRailLibraryView()
  if (path !== '/jobs' && path !== '/jobs/metadata') return children
  const filter = systemLibraryFilter(params.get('mediaType'))
  const tabs = [
    {
      href: filter ? scopedHref('/jobs', filter) : '/jobs',
      label: 'Activity',
      current: path === '/jobs',
    },
    {
      href: scopedHref(
        '/jobs/metadata',
        metadataLibrary(params.get('mediaType'), rail),
      ),
      label: 'Metadata',
      current: path === '/jobs/metadata',
    },
  ]
  return (
    <div className="ops-page">
      <PageHead title="Jobs" />
      <nav className="ds-tabs ops-tabs" aria-label="Jobs">
        {tabs.map((tab) => (
          <Link
            key={tab.label}
            href={tab.href}
            className="ds-tab"
            aria-current={tab.current ? 'page' : undefined}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  )
}
