'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { UserRound } from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
import { useLibraryView } from './media-scope'
import { scopedHref } from '@/utils/media-scope'

export default function UserLink() {
  const path = usePathname()
  const scope = useLibraryView()
  return (
    <Button asChild variant="outline" size="sm" className="gap-1.5">
      <Link
        href={scopedHref('/user', scope)}
        aria-current={path === '/user' ? 'page' : undefined}
        title="User"
      >
        <UserRound size={14} aria-hidden="true" />
        <span className="max-[700px]:sr-only">User</span>
      </Link>
    </Button>
  )
}
