'use client'

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { useMutation } from '@tanstack/react-query'
import {
  Button,
  mutationFeedback,
  type ButtonFeedback,
} from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { Label } from '@repo/ui/components/ui/label'
import { useAnchoredPopover } from './action-menu'
import { playlistNameTaken } from '@/utils/library-playlists'

/** What the name popover is for: its heading and its primary button. */
export type PlaylistNameMode = 'rename' | 'create' | 'save'

export const playlistNameWording: Record<
  PlaylistNameMode,
  { heading: string; submit: string; pending: string; failed: string }
> = {
  rename: {
    heading: 'Rename',
    submit: 'Rename',
    pending: 'Renaming…',
    failed: 'Could not rename · retry',
  },
  create: {
    heading: 'New playlist',
    submit: 'Create',
    pending: 'Creating…',
    failed: 'Could not create · retry',
  },
  save: {
    heading: 'Save smart playlist',
    submit: 'Save',
    pending: 'Saving…',
    failed: 'Could not save · retry',
  },
}

/**
 * The name step: heading, Name, any help lines, "A playlist with this name
 * exists." on a clash, then Cancel and the primary button. Enter submits.
 */
export function PlaylistNameForm({
  headingId,
  mode,
  name,
  taken,
  help,
  feedback,
  onName,
  onCancel,
  onSubmit,
}: {
  headingId: string
  mode: PlaylistNameMode
  name: string
  taken: boolean
  /** Lines under the field, such as a smart playlist's view written out. */
  help?: ReactNode
  feedback?: ButtonFeedback
  onName: (name: string) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  const fieldId = useId()
  const wording = playlistNameWording[mode]
  const pending = feedback?.phase === 'pending'
  return (
    <>
      <div className="ds-pop-head" id={headingId}>
        {wording.heading}
      </div>
      <form
        className="ds-pop-form"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <div className="ds-field">
          <Label htmlFor={fieldId}>Name</Label>
          <Input
            id={fieldId}
            controlSize="md"
            value={name}
            maxLength={200}
            autoComplete="off"
            aria-invalid={taken || undefined}
            onChange={(event) => onName(event.target.value)}
          />
        </div>
        {help}
        {taken && (
          <span className="ds-help" role="alert">
            A playlist with this name exists.
          </span>
        )}
        <span className="ds-actions">
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            feedback={feedback}
            disabled={!name.trim() || taken || pending}
          >
            {wording.submit}
          </Button>
        </span>
      </form>
    </>
  )
}

/**
 * PL-51: the name popover for Rename, New playlist and Save smart playlist,
 * on the button that opened it. With `id` that button opens it as its
 * `popoverTarget`; `showOnMount` opens it at once, as after a menu. Escape
 * and Cancel close it and return focus to the button. `onSubmit` makes the
 * change and reports it; a 409 shows the clash. `isTaken` says whether a name
 * is already known to be taken.
 */
export function PlaylistNamePopover({
  id,
  mode,
  anchor,
  initialName = '',
  help,
  isTaken = () => false,
  showOnMount = false,
  sheet = false,
  onSubmit,
  onOpenChange,
}: {
  id?: string
  mode: PlaylistNameMode
  anchor: RefObject<HTMLElement | null>
  initialName?: string
  help?: ReactNode
  isTaken?: (name: string) => boolean
  showOnMount?: boolean
  /** A sheet at the bottom of a phone screen, as from a row's menu. */
  sheet?: boolean
  onSubmit: (name: string) => Promise<unknown>
  onOpenChange?: (open: boolean) => void
}) {
  const ownId = useId()
  const headingId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  // Inside a modal drawer the popover stays in the drawer, which keeps the
  // rest of the page inert.
  useEffect(
    () => setHost(anchor.current?.closest('dialog') ?? document.body),
    [anchor],
  )
  useEffect(() => {
    if (host && showOnMount) panel.current?.showPopover()
  }, [host, showOnMount])
  useAnchoredPopover(anchor, panel, open, sheet)
  function close() {
    panel.current?.hidePopover()
    if (anchor.current?.isConnected)
      anchor.current.focus({ preventScroll: true })
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation()
    if (event.key !== 'Escape') return
    event.preventDefault()
    close()
  }
  if (!host) return null
  return createPortal(
    <div
      id={id ?? ownId}
      ref={panel}
      popover="auto"
      role="dialog"
      aria-labelledby={headingId}
      className="ds-pop ds-pop-dialog"
      data-sheet={sheet ? '' : undefined}
      onToggle={(event) => {
        const next = event.newState === 'open'
        setOpen(next)
        onOpenChange?.(next)
      }}
      onKeyDown={onKeyDown}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {open && (
        <NameContent
          headingId={headingId}
          mode={mode}
          initialName={initialName}
          help={help}
          isTaken={isTaken}
          panel={panel}
          close={close}
          onSubmit={onSubmit}
        />
      )}
    </div>,
    host,
  )
}

function NameContent({
  headingId,
  mode,
  initialName,
  help,
  isTaken,
  panel,
  close,
  onSubmit,
}: {
  headingId: string
  mode: PlaylistNameMode
  initialName: string
  help?: ReactNode
  isTaken: (name: string) => boolean
  panel: RefObject<HTMLDivElement | null>
  close: () => void
  onSubmit: (name: string) => Promise<unknown>
}) {
  const [name, setName] = useState(initialName)
  const [takenName, setTakenName] = useState<string | null>(null)
  const submit = useMutation({
    mutationFn: onSubmit,
    onSuccess: close,
    onError: (error, submitted) => {
      if (playlistNameTaken(error)) setTakenName(submitted.toLowerCase())
    },
  })
  useEffect(() => {
    const field = panel.current?.querySelector<HTMLInputElement>('input')
    field?.focus({ preventScroll: true })
    field?.select()
  }, [panel])
  const trimmed = name.trim()
  const unchanged =
    mode === 'rename' && trimmed.toLowerCase() === initialName.toLowerCase()
  const taken =
    Boolean(trimmed) &&
    !unchanged &&
    (takenName === trimmed.toLowerCase() || isTaken(trimmed))
  const wording = playlistNameWording[mode]
  return (
    <PlaylistNameForm
      headingId={headingId}
      mode={mode}
      name={name}
      taken={taken}
      help={help}
      feedback={
        submit.isError && playlistNameTaken(submit.error)
          ? undefined
          : mutationFeedback(submit, {
              pending: wording.pending,
              success: wording.submit,
              error: wording.failed,
            })
      }
      onName={setName}
      onCancel={close}
      onSubmit={() => {
        if (!trimmed || taken || submit.isPending) return
        if (unchanged && trimmed === initialName) close()
        else submit.mutate(trimmed)
      }}
    />
  )
}
