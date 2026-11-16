'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { UserRound } from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
import { useLibraryView } from './media-scope'
import { scopedHref } from '@/utils/media-scope'
import { userDetailId } from '@/utils/detail-inspector'
import { DetailLink } from './detail-link'
import { useDetailInspector } from './detail-inspector-context'

export default function UserLink() {
  const path = usePathname()
  const scope = useLibraryView()
  const inspector = useDetailInspector()
  const label = (
    <>
      <UserRound size={14} aria-hidden="true" />
      <span className="max-[700px]:sr-only">User</span>
    </>
  )
  return (
    <Button asChild className="gap-1.5">
      {path === '/user' || !inspector ? (
        <Link
          href={scopedHref('/user', scope)}
          aria-current={path === '/user' ? 'page' : undefined}
          title="User"
        >
          {label}
        </Link>
      ) : (
        <DetailLink
          kind="user"
          id={userDetailId}
          aria-expanded={inspector.active?.kind === 'user'}
          title="User"
        >
          {label}
        </DetailLink>
      )}
    </Button>
  )
}
