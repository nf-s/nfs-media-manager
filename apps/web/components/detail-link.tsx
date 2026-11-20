'use client'

import Link from 'next/link'
import type { ComponentProps } from 'react'
import { detailPageHref, type DetailTarget } from '@/utils/detail-inspector'
import { workspaceTabLinkProps } from '@/utils/workspace-tab-destination'
import { useDetailInspector } from './detail-inspector-context'

type DetailLinkProps = DetailTarget &
  Omit<ComponentProps<typeof Link>, 'id' | 'href'> & {
    tab?: string
    /** Further view state for the open tab, such as an open source row. */
    view?: Record<string, string>
    workspaceLabel?: string
  }

/** Plain clicks open the inspector. Workspace tabs use the item's own page. */
export function DetailLink({
  kind,
  id,
  mediaType,
  tab,
  view: state,
  workspaceLabel,
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
  const pageHref = detailPageHref(target, view)
  return (
    <Link
      {...(inspector
        ? workspaceTabLinkProps(pageHref, workspaceLabel)
        : { 'data-workspace-label': workspaceLabel })}
      {...props}
      href={inspector?.href(target) ?? pageHref}
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
