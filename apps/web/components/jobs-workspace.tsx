'use client'

import { usePathname } from 'next/navigation'
import { SectionSidebar, SectionWorkspace } from './section-sidebar'
import { useWorkspaceScope } from './media-scope'
import { scopedHref } from '@/utils/media-scope'

const history = { id: '/jobs', href: '/jobs', label: 'Jobs & history' }
const destinations = [
  history,
  {
    id: '/jobs/metadata',
    href: '/jobs/metadata',
    label: 'Metadata',
  },
]

export default function JobsWorkspace({
  children,
}: {
  children: React.ReactNode
}) {
  const path = usePathname()
  const mediaType = useWorkspaceScope()
  // Subscriptions has no media items to scrape.
  const items = mediaType === 'subscription' ? [history] : destinations
  return (
    <SectionWorkspace
      key={mediaType}
      sidebar={
        <div className="min-h-0 overflow-auto">
          <SectionSidebar
            label="Jobs navigation"
            items={items.map((item) => ({
              ...item,
              href: scopedHref(item.href, mediaType),
            }))}
            activeId={path}
          />
        </div>
      }
    >
      {children}
    </SectionWorkspace>
  )
}
