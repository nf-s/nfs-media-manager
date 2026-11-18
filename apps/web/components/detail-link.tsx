'use client'

import Link from 'next/link'
import type { ComponentProps } from 'react'
import { detailPageHref, type DetailTarget } from '@/utils/detail-inspector'
import { useDetailInspector } from './detail-inspector-context'

type DetailLinkProps = DetailTarget &
  Omit<ComponentProps<typeof Link>, 'id' | 'href'> & {
    tab?: string
    /** Further view state for the open tab, such as an open source row. */
    view?: Record<string, string>
  }

/** Normal clicks open the inspector; copied and modified clicks follow its URL. */
export function DetailLink({
  kind,
  id,
  mediaType,
  tab,
  view: state,
  onClick,
  ...props
}: DetailLinkProps) {
  const inspector = useDetailInspector()
  const view =
    tab || state
      ? new URLSearchParams({ ...(tab ? { tab } : {}), ...state })
      : undefined
  const target = {
    kind,
    id,
    ...(kind === 'collection' && mediaType === 'album' ? { mediaType } : {}),
    view: view?.toString(),
  }
  return (
    <Link
      {...props}
      href={inspector?.href(target) ?? detailPageHref(target, view)}
      prefetch={false}
      onClick={(event) => {
        onClick?.(event)
        if (
          !inspector ||
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.altKey ||
          event.ctrlKey ||
          event.shiftKey ||
          (props.target && props.target !== '_self')
        )
          return
        event.preventDefault()
        event.stopPropagation()
        inspector.open(target, event.currentTarget)
      }}
    />
  )
}
