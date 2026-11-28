'use client'

import { useId, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ListMusic } from 'lucide-react'
import {
  LIBRARY_PLAYLIST_FILTER_FIELD,
  type BrowseField,
  type BrowseFilter,
} from '@repo/schemas/browse'
import {
  parseLibraryBrowseView,
  type LibraryPlaylistDetail,
  type LibraryPlaylistLibrary,
  type LibraryPlaylistSummary,
  type LibraryPlaylistView,
} from '@repo/schemas/library-playlists'
import { Button, mutationFeedback } from '@repo/ui/components/ui/button'
import { Notice } from '@repo/ui/components/ds/feedback'
import { RailActions, RailView, ViewName } from '@repo/ui/components/ds/rail'
import { Select } from '@repo/ui/components/ds/toolbar'
import type { BrowseHost } from '@/hooks/useBrowseHost'
import { clientQueryDefaults } from '@/utils/query-cache'
import {
  createLibraryPlaylist,
  deleteLibraryPlaylist,
  fetchLibraryPlaylist,
  fetchAllLibraryPlaylists,
  invalidateLibraryPlaylists,
  libraryBrowsePaths,
  libraryPlaylistKey,
  libraryPlaylistsKey,
  libraryPlaylistSuggestions,
  playlistNotFound,
  SMART_PLAYLIST_PARAM,
  updateLibraryPlaylistView,
} from '@/utils/library-playlists'
import { describeSavedView } from '@/utils/saved-view-sentence'
import {
  applyBrowseView,
  browseHasSmartPlaylists,
  browseView,
  browseViewHasCriteria,
  clearBrowseView,
  libraryPlaylistsHref,
  nothingToSaveReason,
  sameBrowseView,
  savedSmartPlaylistText,
  updatedSmartPlaylistText,
  updateSmartPlaylistLabel,
} from '@/utils/smart-playlists'
import { FilterPanelSection } from './browse-filter-panel'
import { useLibraryPlaylistNames } from './library-playlist-name'
import { PlaylistNamePopover } from './playlist-name-popover'
import { useConfig } from './providers'
import { ReadButton } from './read-button'
import { useReportResult, type ResultReport } from './result-line'

/** The smart playlist open in Browse: its ID is in the URL and it was found. */
export type OpenSmartPlaylist = {
  id: string
  name: string
  view: LibraryPlaylistView
}

/** Smart playlists in one library's Browse (PL-40 to PL-43). */
export type SmartPlaylistBrowse = {
  library: LibraryPlaylistLibrary
  /** The current view, as it would be saved. */
  view: LibraryPlaylistView
  /** The current view written out (PL-41). */
  sentence: string
  /** A search, or a filter, range or listening condition, to save. */
  canSave: boolean
  /** The name the Save popover suggests. */
  suggestedName: string
  open: OpenSmartPlaylist | null
  /** The smart playlist named in the URL is still being read. */
  loading: boolean
  /** The open smart playlist's view differs from the current one. */
  changed: boolean
  /** Creates a smart playlist with the current view and opens it. */
  save: (name: string) => Promise<void>
  /** Saves the current view over the open smart playlist's. */
  update: () => Promise<void>
  /** Clears the view and the smart playlist's ID. */
  close: () => void
  /** Opens a smart playlist with its view. */
  choose: (playlist: Pick<OpenSmartPlaylist, 'id' | 'view'>) => void
}

const playlistIds = (
  library: LibraryPlaylistLibrary,
  view: LibraryPlaylistView,
) => {
  const parsed = parseLibraryBrowseView(library, view)
  if (!parsed.success) return []
  const filters: readonly BrowseFilter[] = parsed.data.query.filters
  return filters.flatMap((filter) =>
    filter.field === LIBRARY_PLAYLIST_FILTER_FIELD ? [filter.value] : [],
  )
}

/**
 * PL-43: the smart playlist the URL names, once read. A deleted or unknown
 * one, a playlist, or another library's is none, and the view stays.
 */
export function openSmartPlaylist(
  library: LibraryPlaylistLibrary,
  id: string | null,
  read: { data?: LibraryPlaylistDetail; isError: boolean },
): OpenSmartPlaylist | null {
  // A deleted playlist's read fails after it succeeded; its data is stale.
  const found = read.isError ? undefined : read.data
  return id &&
    found &&
    found.id === id &&
    found.type === 'smart' &&
    found.library === library &&
    found.view
    ? { id: found.id, name: found.name, view: found.view }
    : null
}

/**
 * The smart playlist state of a Browse page: the current view, the smart
 * playlist named by `smartPlaylist` in the URL and the actions on them.
 * Null for a library without smart playlists in Browse and inside details.
 */
export function useSmartPlaylistBrowse({
  library,
  host,
  order,
  fields,
  suggestedName,
}: {
  library: LibraryPlaylistLibrary | null
  host: BrowseHost
  order: { sortBy: string; direction: 'asc' | 'desc' }
  fields?: readonly BrowseField[]
  suggestedName: string
}): SmartPlaylistBrowse | null {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const report = useReportResult()
  const enabled = browseHasSmartPlaylists(library) && !host.embedded
  const id = host.params.get(SMART_PLAYLIST_PARAM)
  const openRead = useQuery({
    queryKey: libraryPlaylistKey(id ?? ''),
    queryFn: ({ signal }) => fetchLibraryPlaylist(apiBaseUrl, id ?? '', signal),
    enabled: enabled && Boolean(id),
    ...clientQueryDefaults,
    retry: (count, error) => !playlistNotFound(error) && count < 2,
    retryOnMount: false,
  })
  const current =
    enabled && library ? browseView(library, host.params, order) : {}
  const playlistName = useLibraryPlaylistNames(
    library ? playlistIds(library, current) : [],
  )
  if (!enabled || !library) return null
  const open = openSmartPlaylist(library, id, openRead)
  /** Changes the Browse URL only while it is still this library's Browse. */
  const updateBrowse = (apply: (params: URLSearchParams) => void) => {
    if (window.location.pathname === libraryBrowsePaths[library])
      host.update(apply)
  }
  return {
    library,
    view: current,
    sentence: describeSavedView({
      library,
      view: current,
      playlistName,
      fields,
    }),
    canSave: browseViewHasCriteria(library, current),
    suggestedName,
    open,
    loading: Boolean(id) && openRead.isPending,
    changed: open !== null && !sameBrowseView(library, open.view, current),
    ...smartPlaylistActions({
      apiBaseUrl,
      library,
      view: current,
      open,
      remember: (playlist) =>
        client.setQueryData(libraryPlaylistKey(playlist.id), playlist),
      refresh: (playlistId) => invalidateLibraryPlaylists(client, playlistId),
      report,
      updateBrowse,
    }),
  }
}

/**
 * Save, Update, Close and choosing a saved view. Save and Update report on
 * the result line with **Playlists** and Undo: Undo of Save deletes the
 * smart playlist and takes its ID out of the URL; Undo of Update puts the
 * previous view back on the server and leaves Browse as it is.
 */
export function smartPlaylistActions({
  apiBaseUrl,
  library,
  view,
  open,
  remember,
  refresh,
  report,
  updateBrowse,
}: {
  apiBaseUrl: string
  library: LibraryPlaylistLibrary
  /** The current view. */
  view: LibraryPlaylistView
  open: OpenSmartPlaylist | null
  /** Keeps a playlist's read, so the rail shows it at once. */
  remember: (playlist: LibraryPlaylistDetail) => void
  refresh: (playlistId: string) => Promise<unknown>
  report: (report: ResultReport) => void
  updateBrowse: (apply: (params: URLSearchParams) => void) => void
}): Pick<SmartPlaylistBrowse, 'save' | 'update' | 'close' | 'choose'> {
  const playlists = { label: 'Playlists', href: libraryPlaylistsHref(library) }
  return {
    async save(name) {
      const { playlist } = await createLibraryPlaylist(apiBaseUrl, {
        type: 'smart',
        library,
        name,
        view,
      })
      remember(playlist)
      updateBrowse((params) => params.set(SMART_PLAYLIST_PARAM, playlist.id))
      void refresh(playlist.id)
      report({
        text: savedSmartPlaylistText(playlist.name),
        action: playlists,
        undo: async () => {
          await deleteLibraryPlaylist(apiBaseUrl, playlist.id)
          updateBrowse((params) => {
            if (params.get(SMART_PLAYLIST_PARAM) === playlist.id)
              params.delete(SMART_PLAYLIST_PARAM)
          })
          await refresh(playlist.id)
        },
      })
    },
    async update() {
      if (!open) return
      const previous = open.view
      const playlist = await updateLibraryPlaylistView(
        apiBaseUrl,
        open.id,
        view,
      )
      remember(playlist)
      void refresh(playlist.id)
      report({
        text: updatedSmartPlaylistText(playlist.name),
        action: playlists,
        undo: async () => {
          remember(
            await updateLibraryPlaylistView(apiBaseUrl, playlist.id, previous),
          )
          await refresh(playlist.id)
        },
      })
    },
    close() {
      updateBrowse((params) => clearBrowseView(params, library))
    },
    choose(playlist) {
      updateBrowse((params) =>
        applyBrowseView(params, library, playlist.view, playlist.id),
      )
    },
  }
}

/** The help lines of the Save smart playlist popover. */
function SaveHelp({ sentence }: { sentence: string }) {
  return (
    <>
      <span className="ds-help">{sentence}</span>
      <span className="ds-help">
        Lists what matches each time it is opened.
      </span>
    </>
  )
}

/** A button that opens the Save smart playlist popover on itself. */
function SaveSmartPlaylistButton({
  smart,
  size,
  icon = false,
  disabled = false,
  title,
  children,
}: {
  smart: SmartPlaylistBrowse
  size?: 'xs'
  icon?: boolean
  disabled?: boolean
  title?: string
  children: ReactNode
}) {
  const id = useId()
  const anchor = useRef<HTMLButtonElement>(null)
  return (
    <>
      <Button
        ref={anchor}
        type="button"
        size={size}
        disabled={disabled}
        title={title}
        popoverTarget={id}
        aria-haspopup="dialog"
        aria-controls={id}
      >
        {icon && <ListMusic className="ds-i" data-size="sm" aria-hidden />}
        {children}
      </Button>
      {!disabled && (
        <PlaylistNamePopover
          id={id}
          mode="save"
          anchor={anchor}
          initialName={smart.suggestedName}
          help={<SaveHelp sentence={smart.sentence} />}
          onSubmit={smart.save}
        />
      )}
    </>
  )
}

/** Update: saves the current view over the open smart playlist's. */
function UpdateButton({
  smart,
  size,
  children,
}: {
  smart: SmartPlaylistBrowse
  size?: 'xs'
  children: ReactNode
}) {
  const update = useMutation({ mutationFn: smart.update })
  const feedback = mutationFeedback(update, {
    pending: 'Updating…',
    success: 'Updated',
    error: 'Could not update · retry',
  })
  return (
    <Button
      type="button"
      variant="primary"
      size={size}
      feedback={feedback}
      disabled={update.isPending}
      onClick={() => update.mutate()}
    >
      {children}
    </Button>
  )
}

/**
 * The rail's smart playlist heading: "Smart playlist" and its name. In the
 * phone filter row, the name alone.
 */
export function SmartPlaylistName({
  smart,
  place,
}: {
  smart: SmartPlaylistBrowse
  place: 'rail' | 'row'
}) {
  if (!smart.open) return null
  const name = <ViewName name={smart.open.name} changed={smart.changed} />
  return place === 'row' ? (
    name
  ) : (
    <RailView label="Smart playlist">{name}</RailView>
  )
}

/**
 * The rail's and the phone filter row's actions on the view: Save as smart
 * playlist, or for an open smart playlist Update and Save as new while it is
 * changed, then Close.
 */
export function SmartPlaylistActions({
  smart,
  place,
}: {
  smart: SmartPlaylistBrowse
  place: 'rail' | 'row'
}) {
  const { open } = smart
  if (smart.loading) return null
  const actions = open ? (
    <>
      {smart.changed && (
        <>
          <UpdateButton smart={smart} size="xs">
            Update
          </UpdateButton>
          <SaveSmartPlaylistButton smart={smart} size="xs">
            Save as new
          </SaveSmartPlaylistButton>
        </>
      )}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        title="Close this smart playlist and clear its filters"
        onClick={smart.close}
      >
        Close
      </Button>
    </>
  ) : smart.canSave ? (
    <SaveSmartPlaylistButton smart={smart} size="xs" icon>
      Save as smart playlist
    </SaveSmartPlaylistButton>
  ) : null
  if (!actions) return null
  return place === 'rail' ? <RailActions>{actions}</RailActions> : actions
}

/** The read of every smart playlist of a library, for the Saved view select. */
export function smartPlaylistChoicesKey(library: LibraryPlaylistLibrary) {
  return [...libraryPlaylistsKey, 'smart', library]
}

/** Every smart playlist of one library, in name order, for the select. */
function useSmartPlaylistChoices(
  library: LibraryPlaylistLibrary,
  enabled: boolean,
) {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: smartPlaylistChoicesKey(library),
    queryFn: ({ signal }) =>
      fetchAllLibraryPlaylists(apiBaseUrl, { library, type: 'smart' }, signal),
    enabled,
    ...clientQueryDefaults,
  })
}

const noPlaylistSuggestions = { options: [], smartPlaylists: [] }

/**
 * PL-44: the Browse search box's suggestions from the library's playlists
 * and smart playlists. They are read once per library, when text is first
 * searched, and matched in the browser like the other suggestions. None
 * without text or outside a library's Browse.
 */
export function useLibraryPlaylistSuggestions(
  smart: SmartPlaylistBrowse | null,
  search: string,
) {
  const { apiBaseUrl } = useConfig()
  const library = smart?.library ?? null
  const enabled = library !== null && search.trim() !== ''
  const read = useQuery({
    queryKey: [...libraryPlaylistsKey, 'suggestions', library],
    queryFn: ({ signal }) =>
      library ? fetchAllLibraryPlaylists(apiBaseUrl, { library }, signal) : [],
    enabled,
    ...clientQueryDefaults,
  })
  return {
    ...(enabled && library && read.data
      ? libraryPlaylistSuggestions(library, read.data)
      : noPlaylistSuggestions),
    isError: enabled && read.isError,
  }
}

/**
 * Filters → Smart playlists (PL-42): the Saved view select, the current view
 * written out, and Save current view, or Update “Name” and Save as new while
 * the open smart playlist is changed.
 */
export function SmartPlaylistsSection({
  smart,
}: {
  smart: SmartPlaylistBrowse
}) {
  const [shown, setShown] = useState(false)
  const choices = useSmartPlaylistChoices(smart.library, shown)
  const { open } = smart
  const rows: Pick<LibraryPlaylistSummary, 'id' | 'name' | 'view'>[] =
    choices.data ?? []
  const listed =
    open && !rows.some((row) => row.id === open.id) ? [open, ...rows] : rows
  return (
    <FilterPanelSection
      title="Smart playlists"
      icon={<ListMusic className="ds-i" data-size="sm" aria-hidden />}
      onToggle={setShown}
    >
      <div className="browse-form">
        <label className="ds-field">
          <span className="ds-label">Saved view</span>
          <Select
            controlSize="md"
            aria-label="Smart playlist"
            value={open?.id ?? ''}
            onChange={(event) => {
              const playlist = listed.find(
                (row) => row.id === event.target.value,
              )
              if (playlist?.view)
                smart.choose({ id: playlist.id, view: playlist.view })
            }}
          >
            <option value="">
              {choices.isPending && shown ? 'Loading…' : 'Choose a saved view'}
            </option>
            {listed.map((playlist) => (
              <option key={playlist.id} value={playlist.id}>
                {playlist.name}
              </option>
            ))}
          </Select>
        </label>
        {choices.isError && (
          <Notice
            tone="danger"
            action={
              <ReadButton
                type="button"
                size="xs"
                read={() => choices.refetch()}
              >
                Retry
              </ReadButton>
            }
          >
            Could not load smart playlists.
          </Notice>
        )}
        <span className="ds-help">{smart.sentence}</span>
        {open ? (
          smart.changed && (
            <span className="ds-actions">
              <UpdateButton smart={smart}>
                {updateSmartPlaylistLabel(open.name)}
              </UpdateButton>
              <SaveSmartPlaylistButton smart={smart}>
                Save as new
              </SaveSmartPlaylistButton>
            </span>
          )
        ) : (
          <SaveSmartPlaylistButton
            smart={smart}
            icon
            disabled={!smart.canSave}
            title={smart.canSave ? undefined : nothingToSaveReason}
          >
            Save current view
          </SaveSmartPlaylistButton>
        )}
      </div>
    </FilterPanelSection>
  )
}
