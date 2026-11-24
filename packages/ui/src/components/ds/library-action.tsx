import { BookPlus, Search } from 'lucide-react'
import { Button } from '../ui/button'

export type LibraryActionKind =
  | 'track'
  | 'album'
  | 'film'
  | 'artist'
  | 'person'
  | 'playlist'
  | 'collection'
  | 'show'
  | 'item'

/** Keep keyboard focus near the item when a successful add removes its button. */
function restoreFocusOnRemoval(button: HTMLButtonElement | null) {
  if (!button) return
  return () => {
    if (document.activeElement !== button) return
    // The save can also replace the surrounding notice or row actions.
    const scopes: HTMLElement[] = []
    for (
      let scope = button.parentElement;
      scope && scope !== document.body;
      scope = scope.parentElement
    ) {
      scopes.push(scope)
      if (scope.matches('dialog, main, [role="dialog"]')) break
    }
    queueMicrotask(() => {
      if (document.activeElement !== document.body) return
      for (const scope of scopes) {
        if (!scope.isConnected) continue
        const next =
          scope.querySelector<HTMLElement>(
            'a.ds-row-title[href], a[data-workspace-href]',
          ) ??
          scope.querySelector<HTMLElement>(
            'a[href], button:not(:disabled):not([aria-disabled="true"])',
          )
        next?.focus({ preventScroll: true })
        if (document.activeElement !== document.body) return
      }
    })
  }
}

/** Adds a missing item or opens its catalog search for confirmation. */
export function LibraryAction({
  name,
  kind,
  onAdd,
  action = 'add',
  size = 'xs',
  saved = false,
  pending = false,
  disabled = false,
  touch = false,
}: {
  name: string
  kind: LibraryActionKind
  onAdd?: () => void
  action?: 'add' | 'find'
  size?: 'xs' | 'sm'
  saved?: boolean
  pending?: boolean
  disabled?: boolean
  /** Use the larger phone target when there is room beside the title. */
  touch?: boolean
}) {
  if (saved) return null
  const label = pending
    ? `Adding ${kind} to library · ${name}`
    : action === 'find'
      ? `Find ${kind} in library · ${name}`
      : `Add ${kind} to library · ${name}`
  const unavailable = pending || disabled || !onAdd
  const Icon = action === 'find' ? Search : BookPlus

  return (
    <Button
      ref={restoreFocusOnRemoval}
      type="button"
      className="ds-library-action"
      variant="ghost"
      size={size}
      icon
      data-touch={touch ? '' : undefined}
      aria-label={label}
      aria-disabled={unavailable || undefined}
      aria-busy={pending || undefined}
      title={label}
      onClick={(event) => {
        event.stopPropagation()
        if (!unavailable) onAdd?.()
      }}
    >
      <Icon className="ds-i" aria-hidden />
    </Button>
  )
}
