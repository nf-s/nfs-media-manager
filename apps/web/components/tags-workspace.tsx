'use client'

import { usePathname } from 'next/navigation'
import { SectionSidebar, SectionWorkspace } from './section-sidebar'
import { useMediaScope } from './media-scope'
import { scopedHref } from '@/utils/media-scope'

export default function TagsWorkspace({
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
            label="Tags navigation"
            activeId={path}
            items={[
              {
                id: '/tags',
                href: scopedHref('/tags', mediaType),
                label: 'All',
              },
              {
                id: '/tags/hidden',
                href: scopedHref('/tags/hidden', mediaType),
                label: 'Hidden',
              },
            ]}
          />
        </div>
      }
    >
      {children}
    </SectionWorkspace>
  )
}
