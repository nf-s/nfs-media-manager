'use client'

import Link from 'next/link'
import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import {
  LastfmSpotifySearchSchema,
  type LastfmLinkGroup,
} from '@repo/schemas/lastfm'
import type {
  ManualMediaSearchItem,
  ManualMediaSearchResult,
} from '@repo/schemas/manual-add'
import { Button } from '@repo/ui/components/ui/button'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@repo/ui/components/ui/tabs'
import {
  LASTFM_SYNC_POLL_MS,
  lastfmLinkReasonLabels,
  lastfmLinkKey,
  lastfmLinkStrategyLabels,
} from '@/utils/lastfm-sync'
import { AlbumPicker, useLastfmLinkUpdate } from './lastfm-link-controls'
import { errorMessage, invalidateScrobbleLinks } from './lastfm-sync'
import { ManualMediaSearch } from './manual-media-add'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { invalidateManualMediaAddition } from '@/utils/manual-media-add'
import { addAndLinkLastfmAlbum } from '@/utils/lastfm-album-add'
import { scopedHref } from '@/utils/media-scope'

export type LastfmLinkPanelMode = 'library' | 'new'

type SearchSnapshot = {
  query: string
  result: ManualMediaSearchResult
  jobId: string | null
}

function ScrobbleSpotifySearch({
  group,
  active,
  disabled,
  onPendingChange,
  onAdded,
  onChoose,
}: {
  group: LastfmLinkGroup
  active: boolean
  disabled: boolean
  onPendingChange: (pending: boolean) => void
  onAdded: (id: string) => Promise<void>
  onChoose?: (item: ManualMediaSearchItem) => void
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const cacheKey = [
    'lastfm-spotify-manual-search',
    group.artistName,
    group.albumName,
  ]
  const [cached, setCached] = useState(() =>
    client.getQueryData<SearchSnapshot>(cacheKey),
  )
  const stored = useQuery({
    queryKey: ['lastfm-spotify-search', group.artistName, group.albumName],
    retry: false,
    enabled: active,
    staleTime: 0,
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/lastfm/links/spotify-search?${new URLSearchParams({
          artistName: group.artistName,
          albumName: group.albumName ?? '',
        })}`,
        LastfmSpotifySearchSchema,
        { signal },
      ),
    refetchInterval: (query) =>
      query.state.data?.job?.status === 'queued' ||
      query.state.data?.job?.status === 'running'
        ? LASTFM_SYNC_POLL_MS
        : false,
  })
  const job = stored.data?.job
  const matchingCache =
    cached?.jobId === (job?.jobId ?? null) ? cached : undefined
  const running = job?.status === 'queued' || job?.status === 'running'
  const ready = stored.isSuccess && !stored.isFetching && !running
  const result = matchingCache?.result ?? stored.data?.result ?? undefined
  return (
    <>
      {stored.isPending && <p role="status">Loading saved Spotify search…</p>}
      {stored.isError && (
        <p role="alert">
          Could not load the saved Spotify search.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => stored.refetch()}
          >
            Retry
          </button>
        </p>
      )}
      {job && (
        <p role={running ? 'status' : undefined} className="text-sm">
          {running
            ? `Spotify search ${job.status}. `
            : job.errorMessage
              ? `${job.errorMessage} `
              : 'Saved Spotify search. '}
          <Link
            href={scopedHref(
              `/jobs?jobId=${encodeURIComponent(job.jobId)}`,
              'album',
            )}
          >
            View job
          </Link>
        </p>
      )}
      <ManualMediaSearch
        key={job?.jobId ?? 'manual'}
        mediaType="album"
        initialQuery={
          matchingCache?.query ??
          `${group.artistName} ${group.albumName ?? ''}`.slice(0, 200)
        }
        initialResult={result}
        autoSearch={active && ready && !job && !result}
        existingActionLabel="Link"
        disabled={disabled || !ready}
        onPendingChange={onPendingChange}
        onAdded={onAdded}
        onChoose={onChoose}
        onSearchResult={(query, searchResult) => {
          const snapshot = {
            query,
            result: searchResult,
            jobId: job?.jobId ?? null,
          }
          setCached(snapshot)
          client.setQueryData(cacheKey, snapshot)
        }}
      />
    </>
  )
}

export default function LastfmLinkPanel({
  group,
  initialMode = 'library',
  onClose,
  onChoose,
  backgroundError,
  backgroundPending = false,
  onRetry,
}: {
  group: LastfmLinkGroup
  initialMode?: LastfmLinkPanelMode
  onClose: () => void
  onChoose?: (item: ManualMediaSearchItem) => void
  backgroundError?: string
  backgroundPending?: boolean
  onRetry?: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const update = useLastfmLinkUpdate()
  const [adding, setAdding] = useState(false)
  const [mode, setMode] = useState<LastfmLinkPanelMode>(initialMode)
  const [openedNew, setOpenedNew] = useState(initialMode === 'new')
  const locallyBusy = adding || update.isPending
  const busy = backgroundPending || locallyBusy
  const albumName = group.albumName
  const linked = group.reason === 'linked' || group.reason === 'manual'

  useEffect(() => {
    const element = dialog.current
    const previous = document.activeElement
    if (!element?.open) element?.showModal()
    element?.querySelector('input')?.focus()
    return () => {
      element?.close()
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true })
    }
  }, [])

  async function link(albumId: string) {
    if (albumName === null) return
    await update.mutateAsync({
      action: 'link',
      artistName: group.artistName,
      albumName,
      albumId,
    })
    onClose()
  }

  function chooseLibraryAlbum(albumId: string) {
    if (albumName === null || busy) return
    update.mutate(
      { action: 'link', artistName: group.artistName, albumName, albumId },
      { onSuccess: onClose },
    )
  }

  return (
    <dialog
      ref={dialog}
      className="tag-drawer"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!locallyBusy) onClose()
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (!locallyBusy && event.target === event.currentTarget) onClose()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="tag-drawer-inner">
        <div className="detail-topbar">
          <span>Scrobble link</span>
          <button
            type="button"
            aria-label="Close scrobble link"
            disabled={locallyBusy}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <div className="tag-drawer-body">
          <h1 id={titleId}>{albumName ?? 'No album name'}</h1>
          <p className="break-words">{group.artistName}</p>
          <p className="quiet text-xs">
            {group.scrobbles.toLocaleString()} scrobbles ·{' '}
            {lastfmLinkReasonLabels[group.reason]}
          </p>
          {group.strategy && (
            <p className="quiet text-xs">
              {lastfmLinkStrategyLabels[group.strategy]}
            </p>
          )}
          {linked && group.album && (
            <p className="text-sm">
              Library album:{' '}
              <Link className="underline" href={`/albums/${group.album.id}`}>
                {group.album.title}
                {group.album.artists.length
                  ? ` — ${group.album.artists.join(', ')}`
                  : ''}
              </Link>
            </p>
          )}
          {albumName !== null && (
            <>
              {backgroundError && (
                <div role="alert">
                  <p>{backgroundError}</p>
                  {onRetry && (
                    <Button size="sm" variant="outline" onClick={onRetry}>
                      Retry add and link
                    </Button>
                  )}
                </div>
              )}
              {backgroundPending && (
                <p role="status">Adding and linking this album…</p>
              )}
              <div className="flex flex-wrap gap-2">
                {linked && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      update.mutate(
                        {
                          action: 'unlink',
                          artistName: group.artistName,
                          albumName,
                        },
                        { onSuccess: onClose },
                      )
                    }
                  >
                    Unlink
                  </Button>
                )}
                {(group.reason === 'manual' || group.reason === 'excluded') && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      update.mutate(
                        {
                          action: 'auto',
                          artistName: group.artistName,
                          albumName,
                        },
                        { onSuccess: onClose },
                      )
                    }
                  >
                    Automatic
                  </Button>
                )}
              </div>
              {update.isError &&
                (mode === 'library' || update.variables?.action !== 'link') && (
                  <p role="alert">
                    {errorMessage(update.error, 'Could not update the link.')}
                  </p>
                )}
              <Tabs
                value={mode}
                onValueChange={(value) => {
                  if (!busy && (value === 'library' || value === 'new')) {
                    update.reset()
                    if (value === 'new') setOpenedNew(true)
                    setMode(value)
                  }
                }}
                className="min-w-0"
              >
                <TabsList aria-label="Choose album source">
                  <TabsTrigger value="library" disabled={busy}>
                    Library album
                  </TabsTrigger>
                  <TabsTrigger value="new" disabled={busy}>
                    Add new album
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="library" className="mt-3 space-y-4">
                  {group.candidates.length > 0 && (
                    <section aria-label="Possible library albums">
                      <h2 className="mb-2 text-sm font-medium">
                        Possible albums
                      </h2>
                      <ul className="space-y-2">
                        {group.candidates.map((album) => (
                          <li
                            key={album.id}
                            className="flex items-center gap-2"
                          >
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => chooseLibraryAlbum(album.id)}
                            >
                              Link
                            </Button>
                            <Link
                              className="min-w-0 break-words underline"
                              href={`/albums/${album.id}`}
                            >
                              {album.title}
                              {album.artists.length
                                ? ` — ${album.artists.join(', ')}`
                                : ''}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                  <AlbumPicker
                    label={`Album for ${group.artistName} — ${albumName}`}
                    initialQuery={albumName}
                    enabled={mode === 'library'}
                    disabled={busy}
                    onPick={chooseLibraryAlbum}
                  />
                </TabsContent>
                <TabsContent
                  value="new"
                  className="mt-3"
                  forceMount
                  hidden={mode !== 'new'}
                >
                  {openedNew && (
                    <ScrobbleSpotifySearch
                      group={group}
                      active={mode === 'new'}
                      disabled={busy}
                      onPendingChange={setAdding}
                      onAdded={link}
                      onChoose={onChoose}
                    />
                  )}
                </TabsContent>
              </Tabs>
            </>
          )}
        </div>
      </div>
    </dialog>
  )
}

export type LastfmLinkSelection = {
  group: LastfmLinkGroup
  mode: LastfmLinkPanelMode
}

type BackgroundAddition = {
  group: LastfmLinkGroup
  item: ManualMediaSearchItem
  key: string
  error: string | null
}

/** Keeps album additions alive while the user moves between scrobbled names. */
export function LastfmLinkWorkflow({
  selection,
  onSelectionChange,
}: {
  selection: LastfmLinkSelection | null
  onSelectionChange: (selection: LastfmLinkSelection | null) => void
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [operations, setOperations] = useState<BackgroundAddition[]>([])
  const pending = useRef(new Set<string>())
  const added = useRef(new Map<string, string | null>())
  const currentSelection = useRef(selection)
  currentSelection.current = selection
  const addition = useMutation({
    retry: false,
    mutationFn: async ({ group, item }: BackgroundAddition) => {
      if (group.albumName === null)
        throw new Error('The scrobble has no album name.')
      const next = await addAndLinkLastfmAlbum({
        apiBaseUrl,
        source: { artistName: group.artistName, albumName: group.albumName },
        item,
        identities: added.current,
      })
      client.setQueryData(['lastfm-sync'], next)
      await Promise.all([
        invalidateScrobbleLinks(client),
        invalidateManualMediaAddition(client, 'album'),
      ])
    },
    onSuccess: (_, operation) => {
      setOperations((current) =>
        current.filter((item) => item.key !== operation.key),
      )
    },
    onError: (error, operation) => {
      const message = errorMessage(error, 'Could not add and link the album.')
      setOperations((current) =>
        current.map((item) =>
          item.key === operation.key ? { ...item, error: message } : item,
        ),
      )
      if (currentSelection.current === null) {
        const next: LastfmLinkSelection = {
          group: operation.group,
          mode: 'new',
        }
        currentSelection.current = next
        onSelectionChange(next)
      }
    },
    onSettled: (_, __, operation) => {
      pending.current.delete(operation.key)
    },
  })

  function start(group: LastfmLinkGroup, item: ManualMediaSearchItem) {
    const key = lastfmLinkKey(group)
    if (pending.current.has(key)) return
    pending.current.add(key)
    const operation = { group, item, key, error: null }
    setOperations((current) => [
      ...current.filter((entry) => entry.key !== key),
      operation,
    ])
    currentSelection.current = null
    onSelectionChange(null)
    addition.mutate(operation)
  }

  const selectedOperation = selection
    ? operations.find(
        (operation) => operation.key === lastfmLinkKey(selection.group),
      )
    : undefined
  const pendingCount = operations.filter(
    (operation) => operation.error === null,
  ).length
  return (
    <>
      {pendingCount > 0 && (
        <p role="status" className="muted my-2">
          Adding and linking {pendingCount}{' '}
          {pendingCount === 1 ? 'album' : 'albums'} in the background…
        </p>
      )}
      {operations
        .filter((operation) => operation.error !== null)
        .map((operation) => (
          <div key={operation.key} role="alert" className="form-actions my-2">
            <span>
              {operation.group.artistName} — {operation.group.albumName}:{' '}
              {operation.error}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                onSelectionChange({ group: operation.group, mode: 'new' })
              }
            >
              Review
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setOperations((current) =>
                  current.filter((item) => item.key !== operation.key),
                )
              }
            >
              Dismiss
            </Button>
          </div>
        ))}
      {selection && (
        <LastfmLinkPanel
          key={lastfmLinkKey(selection.group)}
          group={selection.group}
          initialMode={selection.mode}
          onClose={() => onSelectionChange(null)}
          onChoose={(item) => start(selection.group, item)}
          backgroundError={selectedOperation?.error ?? undefined}
          backgroundPending={
            selectedOperation !== undefined && selectedOperation.error === null
          }
          onRetry={
            selectedOperation?.error
              ? () => start(selectedOperation.group, selectedOperation.item)
              : undefined
          }
        />
      )}
    </>
  )
}
