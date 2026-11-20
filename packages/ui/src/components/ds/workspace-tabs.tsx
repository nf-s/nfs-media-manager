'use client'

import { Plus, X } from 'lucide-react'
import {
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Button } from '../ui/button'

/** ID for the active workspace panel's aria-labelledby. */
export function workspaceTabId(panelId: string, tabId: string) {
  return `${panelId}-tab-${encodeURIComponent(tabId)}`
}

function revealTab(item: HTMLElement | null) {
  const list = item?.parentElement
  if (!item || !list) return

  const itemBounds = item.getBoundingClientRect()
  const listBounds = list.getBoundingClientRect()
  if (itemBounds.left < listBounds.left) {
    list.scrollLeft += itemBounds.left - listBounds.left
  } else if (itemBounds.right > listBounds.right) {
    list.scrollLeft += itemBounds.right - listBounds.right
  }
}

/** Switches between independent workspace views sharing one visible panel. */
export function WorkspaceTabs({
  tabs,
  activeId,
  panelId,
  onSelect,
  onClose,
  onDuplicate,
}: {
  tabs: readonly { id: string; label: string; icon?: ReactNode }[]
  activeId: string
  panelId: string
  onSelect: Dispatch<string>
  onClose: Dispatch<string>
  onDuplicate: () => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const focusActive = useRef(false)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const tabStopId = focusedId ?? activeId

  useLayoutEffect(() => {
    const button = listRef.current?.ownerDocument.getElementById(
      workspaceTabId(panelId, activeId),
    )
    if (!button) return

    if (focusActive.current) {
      focusActive.current = false
      button.focus({ preventScroll: true })
    }
    revealTab(button.parentElement)
  }, [activeId, panelId, tabs.length])

  function closeTab(id: string) {
    focusActive.current = true
    onClose(id)
  }

  function navigateTabs(event: KeyboardEvent<HTMLSpanElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return

    const count = tabs.length
    let nextIndex: number
    switch (event.key) {
      case 'ArrowLeft':
        nextIndex = (index - 1 + count) % count
        break
      case 'ArrowRight':
        nextIndex = (index + 1) % count
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = count - 1
        break
      case 'Delete': {
        event.preventDefault()
        const tab = tabs[index]
        if (tab && !event.repeat) closeTab(tab.id)
        return
      }
      default:
        return
    }

    event.preventDefault()
    const nextTab = tabs[nextIndex]
    if (nextTab) {
      event.currentTarget.ownerDocument
        .getElementById(workspaceTabId(panelId, nextTab.id))
        ?.focus({ preventScroll: true })
    }
  }

  return (
    <div className="ds-workspace-tabs">
      <div
        className="ds-workspace-tab-list"
        role="tablist"
        aria-label="Workspace tabs"
        ref={listRef}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setFocusedId(null)
          }
        }}
      >
        {tabs.map((tab, index) => {
          const selected = tab.id === activeId
          const tabStop = tab.id === tabStopId ? 0 : -1
          const closeLabel = `Close ${tab.label} tab`

          return (
            <span
              key={tab.id}
              className="ds-workspace-tab"
              role="presentation"
              onFocus={(event) => {
                setFocusedId(tab.id)
                revealTab(event.currentTarget)
              }}
              onKeyDown={(event) => navigateTabs(event, index)}
            >
              <Button
                type="button"
                role="tab"
                variant="ghost"
                id={workspaceTabId(panelId, tab.id)}
                aria-controls={panelId}
                aria-selected={selected}
                aria-keyshortcuts="Delete"
                tabIndex={tabStop}
                title={tab.label}
                onClick={(event) => {
                  event.currentTarget.focus({ preventScroll: true })
                  onSelect(tab.id)
                }}
              >
                {tab.icon && (
                  <span className="ds-workspace-tab-icon" aria-hidden="true">
                    {tab.icon}
                  </span>
                )}
                <span className="ds-truncate">{tab.label}</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                icon
                data-close
                tabIndex={tabStop}
                aria-label={closeLabel}
                title={closeLabel}
                onClick={() => closeTab(tab.id)}
              >
                <X className="ds-i" data-size="sm" aria-hidden="true" />
              </Button>
            </span>
          )
        })}
      </div>
      <Button
        type="button"
        variant="ghost"
        icon
        aria-label="Duplicate current tab"
        title="Duplicate current tab"
        onClick={() => {
          focusActive.current = true
          onDuplicate()
        }}
      >
        <Plus className="ds-i" aria-hidden="true" />
      </Button>
    </div>
  )
}
