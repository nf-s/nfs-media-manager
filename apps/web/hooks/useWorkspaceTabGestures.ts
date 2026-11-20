'use client'

import { useEffect } from 'react'
import {
  isWorkspaceTabGesture,
  resolveWorkspaceHref,
} from '@/utils/workspace-tab-destination'

const itemContainers = '.ds-card, .ds-row, tr'
const controls =
  '[data-workspace-href], a, button, input, select, textarea, label, summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="tab"], [role="option"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="slider"], [role="combobox"], [role="textbox"]'
const boundary = `${controls}, ${itemContainers}, dialog, [role="dialog"], [popover]`

/** An item owns its passive metadata. Nested controls and popovers own their own gestures. */
function destinationControl(target: Element) {
  const nearest = target.closest(boundary)
  if (!nearest || nearest.matches(controls)) return nearest
  if (!nearest.matches(itemContainers)) return null
  const title = nearest.querySelector(
    ':is(.ds-card-title, .ds-row-title, .ds-cell-title):is(a, [data-workspace-href])',
  )
  return title?.closest(itemContainers) === nearest ? title : null
}

function destination(event: MouseEvent | KeyboardEvent) {
  if (!(event.target instanceof Element)) return null
  const control = destinationControl(event.target)
  if (!control || control.closest(':disabled, [aria-disabled="true"]'))
    return null
  if ('button' in event && control.matches('input, select, textarea'))
    return null

  const explicit = control.getAttribute('data-workspace-href')
  if (
    control.matches('a[download]') ||
    (!explicit &&
      control.matches(
        'a[rel~="external"], a[target]:not([target=""], [target="_self" i])',
      ))
  )
    return null
  const raw =
    explicit ?? (control.matches('a') ? control.getAttribute('href') : null)
  if (!raw) return null
  const href = resolveWorkspaceHref(raw, new URL(window.location.href))
  if (!href) return null

  const ids = control.getAttribute('aria-labelledby')?.trim().split(/\s+/)
  const label = [
    control.getAttribute('data-workspace-label'),
    ids
      ?.map((id) => document.getElementById(id)?.textContent)
      .filter(Boolean)
      .join(' '),
    control.getAttribute('aria-label'),
    control.textContent,
    control.getAttribute('title'),
  ]
    .map((value) => value?.replace(/\s+/g, ' ').trim())
    .find(Boolean)
  return {
    href,
    label: label ?? new URL(href, window.location.origin).pathname,
  }
}

/** Handle workspace destinations before links, buttons or native navigation. */
export function useWorkspaceTabGestures(
  open: (href: string, label: string) => void,
) {
  useEffect(() => {
    function onGesture(event: MouseEvent | KeyboardEvent) {
      if (!isWorkspaceTabGesture(event)) return
      const target = destination(event)
      if (!target) return
      event.preventDefault()
      event.stopPropagation()
      // Some controls select on press or focus. Wait for the completed click
      // before opening, so a cancelled press leaves both tabs alone.
      if (
        event.type === 'click' ||
        (event.type === 'keydown' && 'repeat' in event && !event.repeat)
      )
        open(target.href, target.label)
    }
    document.addEventListener('pointerdown', onGesture, true)
    document.addEventListener('mousedown', onGesture, true)
    document.addEventListener('click', onGesture, true)
    document.addEventListener('keydown', onGesture, true)
    return () => {
      document.removeEventListener('pointerdown', onGesture, true)
      document.removeEventListener('mousedown', onGesture, true)
      document.removeEventListener('click', onGesture, true)
      document.removeEventListener('keydown', onGesture, true)
    }
  }, [open])
}
