'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Ellipsis } from 'lucide-react'
import {
  Button,
  type ButtonFeedback,
  type ButtonSize,
} from '@repo/ui/components/ui/button'
import type { DetailCrumb } from '@/utils/detail-inspector'
import { ActionMenu, type DetailMenuItem } from './action-menu'
import { useInspectorPage } from './detail-inspector-context'

export type { DetailMenuItem } from './action-menu'

/**
 * More actions, the last button of every detail header: the item's own
 * secondary actions, then Open page in the drawer and Copy link. In the drawer
 * it also names the item in the breadcrumbs, and on a phone it moves to the
 * drawer bar.
 */
export function DetailMore({
  crumb,
  items = [],
  feedback,
}: {
  /** The item's breadcrumb; leave it out until the details have loaded. */
  crumb?: DetailCrumb
  items?: readonly DetailMenuItem[]
  feedback?: ButtonFeedback
}) {
  const page = useInspectorPage()
  const setCrumb = page?.setCrumb
  const title = crumb?.title
  const batchHref = crumb?.batchHref
  useEffect(() => {
    if (setCrumb && title) setCrumb({ title, batchHref })
  }, [setCrumb, title, batchHref])
  const all: DetailMenuItem[] = [
    ...items,
    ...(page
      ? [{ label: 'Open page', href: page.pageHref, workspaceLabel: title }]
      : []),
  ]
  return (
    <>
      <MoreMenu
        items={all}
        pageHref={page?.pageHref}
        size="md"
        className={page?.moreSlot ? 'dtl-more' : undefined}
        feedback={feedback}
      />
      {page?.moreSlot &&
        createPortal(
          <MoreMenu
            items={all}
            pageHref={page.pageHref}
            size="sm"
            feedback={feedback}
          />,
          page.moreSlot,
        )}
    </>
  )
}

function MoreMenu({
  items,
  pageHref,
  size,
  className,
  feedback,
}: {
  items: readonly DetailMenuItem[]
  pageHref: string | undefined
  size: ButtonSize
  className?: string
  feedback?: ButtonFeedback
}) {
  const [copy, setCopy] = useState<'idle' | 'copying' | 'copied' | 'failed'>(
    'idle',
  )
  async function copyLink() {
    setCopy('copying')
    const url = pageHref
      ? new URL(pageHref, window.location.origin).href
      : window.location.href
    try {
      await navigator.clipboard.writeText(url)
      setCopy('copied')
    } catch {
      setCopy('failed')
    }
  }
  return (
    <ActionMenu
      items={items}
      className="dtl-more-pop"
      onOpenChange={(open) => {
        if (!open) setCopy('idle')
      }}
      trigger={(props) => (
        <Button
          type="button"
          variant="ghost"
          size={size}
          icon
          feedback={feedback}
          className={className}
          aria-label="More actions"
          title="More actions"
          {...props}
        >
          <Ellipsis className="ds-i" aria-hidden="true" />
        </Button>
      )}
    >
      <button
        type="button"
        role="menuitem"
        className="ds-menu-item"
        onClick={() => void copyLink()}
        disabled={copy === 'copying'}
        aria-busy={copy === 'copying'}
      >
        {copy === 'copied'
          ? 'Link copied'
          : copy === 'failed'
            ? 'Could not copy link'
            : copy === 'copying'
              ? 'Copying…'
              : 'Copy link'}
      </button>
      <span className="sr-only" role="status">
        {copy === 'copied'
          ? 'Link copied'
          : copy === 'failed'
            ? 'Could not copy link'
            : ''}
      </span>
    </ActionMenu>
  )
}
