'use client'

import { usePathname } from 'next/navigation'
import { SectionSidebar, SectionWorkspace } from './section-sidebar'
import { useMediaScope } from './media-scope'
import { scopedHref } from '@/utils/media-scope'

const destinations = [
  { id: '/jobs', href: '/jobs', label: 'Jobs & history' },
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
  const mediaType = useMediaScope()
  return (
    <SectionWorkspace
      key={mediaType}
      sidebar={
        <div className="min-h-0 overflow-auto">
          <SectionSidebar
            label="Jobs navigation"
            items={destinations.map((item) => ({
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
