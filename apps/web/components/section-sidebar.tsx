'use client'

import Link from 'next/link'
import React, { type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useRailSlot } from '@/hooks/useRailSlot'

type SidebarItem = {
  id: string
  label: string
  description?: string
} & (
  | { href: string; onSelect?: never }
  | { href?: never; onSelect: () => void }
)

export function SectionSidebar({
  label,
  items,
  activeId,
}: {
  label: string
  items: SidebarItem[]
  activeId: string
}) {
  const railSlot = useRailSlot()
  // In the rail the items are second-level navigation; above the page they are tabs.
  const itemClass = railSlot ? 'ds-nav-item' : 'ds-tab'
  const level = railSlot ? '2' : undefined
  const navigation = (
    <nav
      className={railSlot ? 'shell-section-nav' : 'ds-tabs shell-section-tabs'}
      aria-label={label}
    >
      {items.map((item) => {
        const content = (
          <span className="shell-section-text">
            <span className="ds-truncate">{item.label}</span>
            {item.description && (
              <span className="ds-muted ds-truncate">{item.description}</span>
            )}
          </span>
        )
        return item.href !== undefined ? (
          <Link
            key={item.id}
            href={item.href}
            className={itemClass}
            data-level={level}
            aria-current={item.id === activeId ? 'page' : undefined}
          >
            {content}
          </Link>
        ) : (
          <button
            type="button"
            key={item.id}
            className={itemClass}
            data-level={level}
            aria-current={item.id === activeId ? 'true' : undefined}
            onClick={item.onSelect}
          >
            {content}
          </button>
        )
      })}
    </nav>
  )
  return railSlot ? createPortal(navigation, railSlot) : navigation
}

export function SectionWorkspace({
  sidebar,
  children,
}: {
  sidebar: ReactNode
  children: ReactNode
}) {
  return (
    <div className="section-workspace">
      {sidebar}
      <div className="section-content">{children}</div>
    </div>
  )
}
