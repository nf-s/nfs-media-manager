'use client'

import { useEffect } from 'react'
import {
  isWorkspaceTabGesture,
  resolveWorkspaceHref,
} from '@/utils/workspace-tab-destination'

const controls =
  'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], [contenteditable="true"]'

function destination(event: MouseEvent | KeyboardEvent) {
  if (!(event.target instanceof Element)) return null
  const control = event.target.closest(controls)
  if (!control || control.matches(':disabled, [aria-disabled="true"]'))
    return null
  if (event.type === 'click' && control.matches('input, select, textarea'))
    return null

  if (
    control.matches(
      'a[download], a[rel~="external"], a[target]:not([target=""], [target="_self" i])',
    )
  )
    return null
  const raw =
    control.getAttribute('data-workspace-href') ??
    (control.matches('a') ? control.getAttribute('href') : null)
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
      if (!('repeat' in event && event.repeat)) open(target.href, target.label)
    }
    document.addEventListener('click', onGesture, true)
    document.addEventListener('keydown', onGesture, true)
    return () => {
      document.removeEventListener('click', onGesture, true)
      document.removeEventListener('keydown', onGesture, true)
    }
  }, [open])
}
