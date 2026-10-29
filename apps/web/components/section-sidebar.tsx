'use client'

import Link from 'next/link'
import React, { type ReactNode } from 'react'

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
  return (
    <nav className="section-sidebar" aria-label={label}>
      {items.map((item) => {
        const content = (
          <>
            <strong>{item.label}</strong>
            {item.description && <span>{item.description}</span>}
          </>
        )
        return item.href !== undefined ? (
          <Link
            key={item.id}
            href={item.href}
            aria-current={item.id === activeId ? 'page' : undefined}
          >
            {content}
          </Link>
        ) : (
          <button
            type="button"
            key={item.id}
            aria-current={item.id === activeId ? 'true' : undefined}
            onClick={item.onSelect}
          >
            {content}
          </button>
        )
      })}
    </nav>
  )
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
