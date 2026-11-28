'use client'

import {
  useDeferredValue,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ListMusic, Plus, Search } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  LibraryPlaylistDuplicates,
  LibraryPlaylistEntryCheck,
  LibraryPlaylistSummary,
} from '@repo/schemas/library-playlists'
import {
  Button,
  ButtonFeedbackLabel,
  mutationFeedback,
  type ButtonFeedback,
} from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { Label } from '@repo/ui/components/ui/label'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { ReadButton } from './read-button'
import { useConfig } from './providers'
import { useAnchoredPopover } from './action-menu'
import { useReportResult } from './result-line'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import {
  addLibraryPlaylistEntries,
  additionResultText,
  allPresent,
  checkLibraryPlaylistEntries,
  createButtonLabel,
  createdResultText,
  createLibraryPlaylist,
  deleteLibraryPlaylist,
  duplicateEvidence,
  duplicatesLine,
  duplicatesMore,
  fetchLibraryPlaylistPage,
  invalidateLibraryPlaylists,
  libraryItemCount,
  libraryPlaylistPickerKey,
  pickerHeading,
  playlistNameTaken,
  selectionRejection,
  singleItemId,
  singleTitle,
  undoLibraryPlaylistAddition,
  type PlaylistSubject,
} from '@/utils/library-playlists'

const PAGE_SIZE = 25
/** Row heights of the list: a menu item, and a sheet's touch-height item. */
const ROW_HEIGHT = 32
const TOUCH_ROW_HEIGHT = 40
const phone = '(max-width: 700px)'

type Step =
  | { kind: 'list' }
  | { kind: 'new' }
  | {
      kind: 'duplicates'
      playlist: LibraryPlaylistSummary
      /** Null for one item the list already shows as added. */
      check: LibraryPlaylistEntryCheck | null
    }

type Addition = {
  playlist: LibraryPlaylistSummary
  duplicates: LibraryPlaylistDuplicates
}

/**
 * Add to playlist: the list of a library's playlists with New playlist…
 * first, the name of a new one, or what to do with items already there. It is
 * a popover on the button that opened it: the selection bar's button, or the
 * More button of the row whose menu chose Add to playlist… (`sheet`, a sheet
 * at the bottom of a phone screen). With `id` the button opens it as its
 * `popoverTarget`; `showOnMount` opens it at once, as after a menu.
 */
export function LibraryPlaylistPicker({
  id,
  subject,
  anchor,
  sheet = false,
  showOnMount = false,
  suggestedName = '',
  excludePlaylistId,
  onOpenChange,
  onAdded,
}: {
  id?: string
  subject: PlaylistSubject
  anchor: RefObject<HTMLElement | null>
  sheet?: boolean
  showOnMount?: boolean
  /** The name New playlist… suggests when there is no search text. */
  suggestedName?: string
  /** The playlist being viewed, which is left out. */
  excludePlaylistId?: string
  onOpenChange?: (open: boolean) => void
  /** After the items were added, as when a selection is cleared. */
  onAdded?: () => void
}) {
  const ownId = useId()
  const panelId = id ?? ownId
  const headingId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => setHost(document.body), [])
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
    // Keys typed here never reach the row, the card or the page behind.
    event.stopPropagation()
    if (event.key !== 'Escape') return
    event.preventDefault()
    close()
  }
  if (!host) return null
  return createPortal(
    <div
      id={panelId}
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
        <PickerContent
          subject={subject}
          panel={panel}
          headingId={headingId}
          touch={sheet}
          suggestedName={suggestedName}
          excludePlaylistId={excludePlaylistId}
          close={close}
          onAdded={onAdded}
        />
      )}
    </div>,
    host,
  )
}

/**
 * The selection bar's Add to playlist, which opens the picker for the
 * selection. `primary` where the bar has no Merge. With none of the ticked
 * rows in the library (PL-02), it is disabled and its title says why.
 */
export function AddToPlaylistButton({
  subject,
  suggestedName,
  primary = false,
  onAdded,
}: {
  subject: PlaylistSubject
  suggestedName?: string
  primary?: boolean
  onAdded?: () => void
}) {
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const none = subject.count === 0
  return (
    <>
      <Button
        ref={button}
        variant={primary ? 'primary' : 'default'}
        disabled={none}
        title={
          none
            ? 'Items outside the library cannot be added to a playlist.'
            : undefined
        }
        popoverTarget={id}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
      >
        Add to playlist
        <ChevronDown className="ds-i" data-size="sm" aria-hidden />
      </Button>
      <LibraryPlaylistPicker
        id={id}
        subject={subject}
        anchor={button}
        suggestedName={suggestedName}
        onOpenChange={setOpen}
        onAdded={onAdded}
      />
    </>
  )
}

function PickerContent({
  subject,
  panel,
  headingId,
  touch,
  suggestedName,
  excludePlaylistId,
  close,
  onAdded,
}: {
  subject: PlaylistSubject
  panel: RefObject<HTMLDivElement | null>
  headingId: string
  touch: boolean
  suggestedName: string
  excludePlaylistId?: string
  close: () => void
  onAdded?: () => void
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const report = useReportResult()
  const [step, setStep] = useState<Step>({ kind: 'list' })
  const [search, setSearch] = useState('')
  const [name, setName] = useState('')
  const [takenName, setTakenName] = useState<string | null>(null)
  const q = useDeferredValue(search.trim())
  const itemId = singleItemId(subject)
  const single = singleTitle(subject) !== null
  const [rowHeight] = useState(() =>
    touch && window.matchMedia(phone).matches ? TOUCH_ROW_HEIGHT : ROW_HEIGHT,
  )
  const choices = useVirtualTable({
    queryKey: libraryPlaylistPickerKey(subject.library, q, itemId),
    pageSize: PAGE_SIZE,
    rowHeight,
    // New playlist… sits above the rows in the same scrolling list.
    headerHeight: rowHeight,
    loadPage: async (page, size, signal) => {
      const result = await fetchLibraryPlaylistPage(
        apiBaseUrl,
        { library: subject.library, type: 'playlist', q, page, size, itemId },
        signal,
      )
      return {
        ...result,
        totalCount:
          page === 1 && !result.hasMore ? result.items.length : undefined,
      }
    },
  })

  // Focus moves into each step: its field, else its first button.
  useEffect(() => {
    const target =
      panel.current?.querySelector<HTMLInputElement>('input') ??
      panel.current?.querySelector<HTMLButtonElement>('button')
    target?.focus({ preventScroll: true })
    if (step.kind === 'new' && target instanceof HTMLInputElement)
      target.select()
  }, [panel, step.kind])

  function finish() {
    onAdded?.()
    close()
  }

  const add = useMutation({
    mutationFn: ({ playlist, duplicates }: Addition) =>
      addLibraryPlaylistEntries(
        apiBaseUrl,
        playlist.id,
        subject.selection,
        duplicates,
      ),
    onSuccess: (addition, { playlist }) => {
      void invalidateLibraryPlaylists(client, playlist.id)
      report({
        text: additionResultText(subject, playlist.name, addition),
        playlist: { id: playlist.id, library: subject.library },
        undo: async () => {
          await undoLibraryPlaylistAddition(
            apiBaseUrl,
            playlist.id,
            addition.batchId,
          )
          await invalidateLibraryPlaylists(client, playlist.id)
        },
      })
      finish()
    },
  })
  const check = useMutation({
    mutationFn: (playlist: LibraryPlaylistSummary) =>
      checkLibraryPlaylistEntries(apiBaseUrl, playlist.id, subject.selection),
    onSuccess: (result, playlist) => {
      if (result.present === 0) add.mutate({ playlist, duplicates: 'skip' })
      else setStep({ kind: 'duplicates', playlist, check: result })
    },
  })
  const create = useMutation({
    mutationFn: (playlistName: string) =>
      createLibraryPlaylist(apiBaseUrl, {
        type: 'playlist',
        library: subject.library,
        name: playlistName,
        selection: subject.selection,
      }),
    onSuccess: ({ playlist, addition }) => {
      void invalidateLibraryPlaylists(client, playlist.id)
      report({
        text: createdResultText(
          subject,
          playlist.name,
          addition?.added ?? subject.count,
        ),
        playlist: { id: playlist.id, library: subject.library },
        undo: async () => {
          await deleteLibraryPlaylist(apiBaseUrl, playlist.id)
          await invalidateLibraryPlaylists(client, playlist.id)
        },
      })
      finish()
    },
    onError: (error, playlistName) => {
      if (playlistNameTaken(error)) setTakenName(playlistName.toLowerCase())
    },
  })
  const busy = add.isPending || check.isPending || create.isPending

  function choose(playlist: LibraryPlaylistSummary) {
    if (busy) return
    if (single && playlist.containsItem)
      setStep({ kind: 'duplicates', playlist, check: null })
    else if (single) add.mutate({ playlist, duplicates: 'skip' })
    else check.mutate(playlist)
  }
  /** The phase of the request a playlist's row started. */
  function rowFeedback(id: string): ButtonFeedback | undefined {
    if (check.variables?.id === id) {
      if (check.isPending) return { phase: 'pending', label: 'Checking…' }
      if (check.isError)
        return {
          phase: 'failed',
          label: selectionRejection(check.error) ?? 'Could not check · retry',
        }
    }
    if (step.kind === 'list' && add.variables?.playlist.id === id) {
      if (add.isPending) return { phase: 'pending', label: 'Adding…' }
      if (add.isError)
        return {
          phase: 'failed',
          label: selectionRejection(add.error) ?? 'Could not add · retry',
        }
    }
    return undefined
  }

  const trimmed = name.trim()
  const known = choices.loadedSlots.some(
    ({ item }) => item.name.toLowerCase() === trimmed.toLowerCase(),
  )
  const taken =
    Boolean(trimmed) && (known || takenName === trimmed.toLowerCase())

  if (step.kind === 'new')
    return (
      <PickerNewStep
        headingId={headingId}
        subject={subject}
        name={name}
        taken={taken}
        feedback={
          create.isError && playlistNameTaken(create.error)
            ? undefined
            : mutationFeedback(create, {
                pending: 'Creating…',
                success: 'Created',
                error:
                  selectionRejection(create.error) ??
                  'Could not create · retry',
              })
        }
        onName={setName}
        onBack={() => {
          create.reset()
          setStep({ kind: 'list' })
        }}
        onSubmit={() => {
          if (!trimmed || taken || create.isPending) return
          create.mutate(trimmed)
        }}
      />
    )

  if (step.kind === 'duplicates')
    return (
      <PickerDuplicatesStep
        headingId={headingId}
        subject={subject}
        playlistName={step.playlist.name}
        check={step.check}
        feedback={(duplicates) =>
          add.variables?.duplicates === duplicates
            ? mutationFeedback(add, {
                pending: 'Adding…',
                success: 'Added',
                error: selectionRejection(add.error) ?? 'Could not add · retry',
              })
            : undefined
        }
        busy={add.isPending}
        onCancel={close}
        onAdd={(duplicates) =>
          add.mutate({ playlist: step.playlist, duplicates })
        }
      />
    )

  const rows = choices.slots.filter(
    ({ item }) => !item || item.id !== excludePlaylistId,
  )
  return (
    <PickerListStep
      headingId={headingId}
      subject={subject}
      search={search}
      onSearch={setSearch}
    >
      {choices.isError ? (
        <Notice
          tone="danger"
          action={
            <ReadButton size="xs" read={() => choices.retry()}>
              Retry
            </ReadButton>
          }
        >
          Could not load playlists.
        </Notice>
      ) : null}
      <div
        className="ds-pop-list"
        ref={choices.scroller}
        onScroll={choices.onScroll}
        aria-busy={!choices.hasTotal || choices.isFetching}
      >
        <PickerMenuItem
          icon={<Plus className="ds-i" data-size="sm" aria-hidden />}
          label="New playlist…"
          disabled={busy}
          onSelect={() => {
            setName(search.trim() || suggestedName)
            setTakenName(null)
            setStep({ kind: 'new' })
          }}
        />
        {choices.padTop > 0 && (
          <div aria-hidden="true" style={{ height: choices.padTop }} />
        )}
        {rows.map(({ index, item: playlist }) =>
          playlist ? (
            <PickerPlaylistRow
              key={playlist.id}
              subject={subject}
              playlist={playlist}
              feedback={rowFeedback(playlist.id)}
              disabled={busy}
              onChoose={() => choose(playlist)}
            />
          ) : (
            <div
              key={`slot-${index}`}
              className="ds-pop-slot"
              aria-hidden="true"
              style={{ height: choices.rowHeight }}
            >
              <Skeleton width="70%" height={12} />
            </div>
          ),
        )}
        {choices.padBottom > 0 && (
          <div aria-hidden="true" style={{ height: choices.padBottom }} />
        )}
        {q && choices.hasTotal && choices.total === 0 && (
          <p className="ds-sortpop-none">No playlist matches</p>
        )}
      </div>
    </PickerListStep>
  )
}

function PickerMenuItem({
  icon,
  label,
  hint,
  disabled,
  onSelect,
}: {
  icon: ReactNode
  label: string
  hint?: ReactNode
  disabled?: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      className="ds-menu-item"
      title={label}
      disabled={disabled}
      onClick={onSelect}
    >
      {icon}
      <span className="ds-truncate">{label}</span>
      {hint !== undefined && <span className="ds-muted">{hint}</span>}
    </button>
  )
}

/** The list step: heading, Find a playlist, then the list it is given. */
export function PickerListStep({
  headingId,
  subject,
  search,
  onSearch,
  children,
}: {
  headingId: string
  subject: PlaylistSubject
  search: string
  onSearch: (search: string) => void
  children: ReactNode
}) {
  return (
    <>
      <div className="ds-pop-head" id={headingId}>
        {pickerHeading(subject)}
      </div>
      <label className="ds-search">
        <Search className="ds-i" data-size="sm" aria-hidden />
        <input
          type="search"
          placeholder="Find a playlist"
          aria-label="Find a playlist"
          value={search}
          maxLength={200}
          autoComplete="off"
          onChange={(event) => onSearch(event.target.value)}
        />
      </label>
      {children}
    </>
  )
}

/**
 * One playlist in the list with its count, or for one item already in it a
 * tick and "Already added". `feedback` is the phase of the request it started.
 */
export function PickerPlaylistRow({
  subject,
  playlist,
  feedback,
  disabled = false,
  onChoose,
}: {
  subject: PlaylistSubject
  playlist: LibraryPlaylistSummary
  feedback?: ButtonFeedback
  disabled?: boolean
  onChoose: () => void
}) {
  const added = singleTitle(subject) !== null && playlist.containsItem === true
  const Icon = added ? Check : ListMusic
  return (
    <PickerMenuItem
      icon={<Icon className="ds-i" data-size="sm" aria-hidden />}
      label={playlist.name}
      hint={
        feedback ? (
          <ButtonFeedbackLabel feedback={feedback} />
        ) : added ? (
          'Already added'
        ) : (
          libraryItemCount(subject.library, playlist.entryCount ?? 0)
        )
      }
      disabled={disabled && !feedback}
      onSelect={onChoose}
    />
  )
}

/** The New playlist step: Name, then Back and Create and add. */
export function PickerNewStep({
  headingId,
  subject,
  name,
  taken,
  feedback,
  onName,
  onBack,
  onSubmit,
}: {
  headingId: string
  subject: PlaylistSubject
  name: string
  taken: boolean
  feedback?: ButtonFeedback
  onName: (name: string) => void
  onBack: () => void
  onSubmit: () => void
}) {
  const fieldId = useId()
  const pending = feedback?.phase === 'pending'
  return (
    <>
      <div className="ds-pop-head" id={headingId}>
        New playlist
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
            onClick={onBack}
          >
            Back
          </Button>
          <Button
            type="submit"
            variant="primary"
            feedback={feedback}
            disabled={!name.trim() || taken || pending}
          >
            {createButtonLabel(subject)}
          </Button>
        </span>
      </form>
    </>
  )
}

/**
 * The duplicates step, headed by the playlist's name: how much of the
 * selection is there with the first five as evidence, then Cancel, Add again
 * and, when only some are there, Skip duplicates.
 */
export function PickerDuplicatesStep({
  headingId,
  subject,
  playlistName,
  check,
  feedback,
  busy,
  onCancel,
  onAdd,
}: {
  headingId: string
  subject: PlaylistSubject
  playlistName: string
  check: LibraryPlaylistEntryCheck | null
  feedback: (
    duplicates: LibraryPlaylistDuplicates,
  ) => ButtonFeedback | undefined
  busy: boolean
  onCancel: () => void
  onAdd: (duplicates: LibraryPlaylistDuplicates) => void
}) {
  const every = allPresent(subject, check)
  const more = check && duplicatesMore(check)
  return (
    <>
      <div
        className="ds-pop-head ds-truncate"
        id={headingId}
        title={playlistName}
      >
        {playlistName}
      </div>
      <div className="ds-pop-form">
        <b>{duplicatesLine(subject, check)}</b>
        {singleTitle(subject) === null && check && check.sample.length > 0 && (
          <ul className="ds-pop-evidence">
            {check.sample.map((item) => (
              <li key={item.id} className="ds-truncate">
                {duplicateEvidence(item)}
              </li>
            ))}
            {more && <li className="ds-muted">{more}</li>}
          </ul>
        )}
        <span className="ds-actions">
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant={every ? 'primary' : 'default'}
            feedback={feedback('again')}
            disabled={busy}
            onClick={() => onAdd('again')}
          >
            Add again
          </Button>
          {!every && (
            <Button
              variant="primary"
              feedback={feedback('skip')}
              disabled={busy}
              onClick={() => onAdd('skip')}
            >
              Skip duplicates
            </Button>
          )}
        </span>
      </div>
    </>
  )
}
