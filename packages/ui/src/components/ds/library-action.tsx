import { BookCheck, BookPlus } from 'lucide-react'
import { Button } from '../ui/button'

/** Adds one item or opens its catalog search. Saved items keep a focusable status. */
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
  kind:
    | 'track'
    | 'album'
    | 'film'
    | 'artist'
    | 'person'
    | 'playlist'
    | 'collection'
    | 'show'
    | 'item'
  onAdd?: () => void
  action?: 'add' | 'find'
  size?: 'xs' | 'sm'
  saved?: boolean
  pending?: boolean
  disabled?: boolean
  /** Use the larger phone target when there is room beside the title. */
  touch?: boolean
}) {
  const label = saved
    ? `${name} is in your library (${kind})`
    : pending
      ? `Adding ${kind} to library · ${name}`
      : action === 'find'
        ? `Find ${kind} in library · ${name}`
        : `Add ${kind} to library · ${name}`
  const unavailable = saved || pending || disabled || !onAdd
  const Icon = saved ? BookCheck : BookPlus

  return (
    <Button
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
