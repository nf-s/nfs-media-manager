'use client'

import { ReadButton } from '@/components/read-button'
import { DetailLink } from './detail-link'
import { AlbumReferencePlayButton } from './play-controls'
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
import {
  Button,
  ButtonFeedbackLabel,
  mutationFeedback,
  type ButtonFeedback,
} from '@repo/ui/components/ui/button'
import { DetailHeader } from '@repo/ui/components/ds/detail-header'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { formatItemCount } from '@repo/ui/lib/format'
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

export type LastfmLinkPanelMode = 'library' | 'new'

const SCROBBLES = { one: 'scrobble', other: 'scrobbles' }
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
  onOpenJob,
}: {
  group: LastfmLinkGroup
  active: boolean
  disabled: boolean
  onPendingChange: (pending: boolean) => void
  onAdded: (id: string) => Promise<void>
  onChoose?: (item: ManualMediaSearchItem) => void
  onOpenJob: () => void
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
      {stored.isPending && <Skeleton width="60%" height={16} />}
      {stored.isError && (
        <Notice
          tone="danger"
          action={
            <ReadButton size="xs" read={() => stored.refetch()}>
              Retry
            </ReadButton>
          }
        >
          Could not load the saved Spotify search.
        </Notice>
      )}
      {job && (
        <p role={running ? 'status' : undefined} className="ds-help">
          {running
            ? `Spotify search ${job.status}. `
            : job.errorMessage
              ? `${job.errorMessage} `
              : 'Saved Spotify search. '}
          <DetailLink
            kind="job"
            id={job.jobId}
            onClick={(event) => {
              if (
                event.button === 0 &&
                !event.metaKey &&
                !event.altKey &&
                !event.ctrlKey &&
                !event.shiftKey
              )
                onOpenJob()
            }}
          >
            View job
          </DetailLink>
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
        tracksPlayed={stored.data?.tracksPlayed || undefined}
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
  onChanged,
}: {
  group: LastfmLinkGroup
  initialMode?: LastfmLinkPanelMode
  onClose: () => void
  onChoose?: (item: ManualMediaSearchItem) => void
  backgroundError?: string
  backgroundPending?: boolean
  onRetry?: () => void
  onChanged?: (label: string, albumId?: string) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const update = useLastfmLinkUpdate()
  const [adding, setAdding] = useState(false)
  const [mode, setMode] = useState<LastfmLinkPanelMode>(initialMode)
  const [openedNew, setOpenedNew] = useState(initialMode === 'new')
  const locallyBusy = adding || update.isPending
  function linkFeedback(action: 'link' | 'unlink' | 'auto', albumId?: string) {
    if (
      update.variables?.action !== action ||
      (action === 'link' &&
        update.variables.action === 'link' &&
        update.variables.albumId !== albumId)
    )
      return undefined
    return mutationFeedback(
      update,
      action === 'link'
        ? {
            pending: 'Linking scrobbles…',
            success: 'Scrobbles linked',
            error: 'Could not link',
          }
        : action === 'unlink'
          ? {
              pending: 'Unlinking…',
              success: 'Unlinked',
              error: 'Could not unlink',
            }
          : {
              pending: 'Restoring automatic linking…',
              success: 'Automatic linking restored',
              error: 'Could not restore automatic linking',
            },
    )
  }
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
    finish('Scrobbles linked', albumId)
  }

  function finish(label: string, albumId?: string) {
    onChanged?.(label, albumId)
    onClose()
  }

  function chooseLibraryAlbum(albumId: string) {
    if (albumName === null || busy) return
    update.mutate(
      { action: 'link', artistName: group.artistName, albumName, albumId },
      { onSuccess: () => finish('Scrobbles linked', albumId) },
    )
  }

  return (
    <dialog
      ref={dialog}
      className="sec-drawer"
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
      <div className="ds-inspector">
        <div className="ds-inspector-bar">
          <span className="ds-crumbs">
            <b>Scrobble link</b>
          </span>
          <Button
            variant="ghost"
            icon
            aria-label="Close scrobble link"
            disabled={locallyBusy}
            onClick={onClose}
          >
            <X className="ds-i" aria-hidden="true" />
          </Button>
        </div>
        <div className="ds-inspector-body sec-stack">
          <DetailHeader
            kind="Scrobbled album"
            title={<span id={titleId}>{albumName ?? 'No album name'}</span>}
            by={group.artistName}
            facts={[
              formatItemCount(group.scrobbles, SCROBBLES),
              lastfmLinkReasonLabels[group.reason],
              group.strategy ? lastfmLinkStrategyLabels[group.strategy] : null,
            ]}
            actions={
              albumName !== null &&
              (linked ||
                group.reason === 'manual' ||
                group.reason === 'excluded') && (
                <>
                  {linked && (
                    <Button
                      size="md"
                      disabled={busy}
                      feedback={linkFeedback('unlink')}
                      onClick={() =>
                        update.mutate(
                          {
                            action: 'unlink',
                            expectedAlbumId: group.album?.id,
                            artistName: group.artistName,
                            albumName,
                          },
                          { onSuccess: () => finish('Scrobbles unlinked') },
                        )
                      }
                    >
                      Unlink
                    </Button>
                  )}
                  {(group.reason === 'manual' ||
                    group.reason === 'excluded') && (
                    <Button
                      size="md"
                      disabled={busy}
                      feedback={linkFeedback('auto')}
                      onClick={() =>
                        update.mutate(
                          {
                            action: 'auto',
                            artistName: group.artistName,
                            albumName,
                          },
                          {
                            onSuccess: () =>
                              finish('Automatic linking restored'),
                          },
                        )
                      }
                    >
                      Automatic
                    </Button>
                  )}
                </>
              )
            }
          />
          {linked && group.album && (
            <p className="sec-line">
              Library album:{' '}
              <DetailLink kind="album" id={group.album.id}>
                {group.album.title}
                {group.album.artists.length
                  ? ` — ${group.album.artists.join(', ')}`
                  : ''}
              </DetailLink>
              <AlbumReferencePlayButton
                id={group.album.id}
                title={group.album.title}
              />
            </p>
          )}
          {albumName !== null && (
            <>
              {backgroundError && (
                <Notice
                  tone="danger"
                  action={
                    onRetry && (
                      <Button size="xs" onClick={onRetry}>
                        Retry add and link
                      </Button>
                    )
                  }
                >
                  {backgroundError}
                </Notice>
              )}
              {backgroundPending && (
                <Notice>Adding and linking this album…</Notice>
              )}
              {update.isError &&
                (mode === 'library' || update.variables?.action !== 'link') && (
                  <Notice tone="danger">
                    {errorMessage(update.error, 'Could not update the link.')}
                  </Notice>
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
                <TabsContent value="library" className="sec-stack">
                  {group.candidates.length > 0 && (
                    <Section title="Possible albums" flush>
                      <ul
                        className="sec-stack"
                        aria-label="Possible library albums"
                      >
                        {group.candidates.map((album) => (
                          <li key={album.id} className="sec-line">
                            <Button
                              size="xs"
                              disabled={busy}
                              feedback={linkFeedback('link', album.id)}
                              onClick={() => chooseLibraryAlbum(album.id)}
                            >
                              Link
                            </Button>
                            <DetailLink
                              className="min-w-0 break-words"
                              kind="album"
                              id={album.id}
                            >
                              {album.title}
                              {album.artists.length
                                ? ` — ${album.artists.join(', ')}`
                                : ''}
                            </DetailLink>
                            <AlbumReferencePlayButton
                              id={album.id}
                              title={album.title}
                            />
                          </li>
                        ))}
                      </ul>
                    </Section>
                  )}
                  <AlbumPicker
                    label={`Album for ${group.artistName} — ${albumName}`}
                    initialQuery={albumName}
                    feedback={(id) => linkFeedback('link', id)}
                    enabled={mode === 'library'}
                    disabled={busy}
                    onPick={chooseLibraryAlbum}
                  />
                </TabsContent>
                <TabsContent
                  value="new"
                  className="sec-stack"
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
                      onOpenJob={onClose}
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
  albumId: string | null
  done: boolean
}

function additionFeedback(operation: BackgroundAddition): ButtonFeedback {
  if (operation.done) return { phase: 'done', label: 'Scrobbles linked' }
  if (operation.error)
    return operation.albumId
      ? { phase: 'partial', label: 'Album saved · retry linking' }
      : { phase: 'failed', label: 'Could not add and link' }
  return {
    phase: 'pending',
    label: operation.albumId ? 'Album saved · linking…' : 'Adding album…',
  }
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
  const [linkResult, setLinkResult] = useState<{
    label: string
    group: LastfmLinkGroup
    albumId?: string
  } | null>(null)
  const pending = useRef(new Set<string>())
  const added = useRef(new Map<string, string | null>())
  const currentSelection = useRef(selection)
  currentSelection.current = selection
  const addition = useMutation({
    retry: false,
    mutationFn: async ({ group, item, key }: BackgroundAddition) => {
      if (group.albumName === null)
        throw new Error('The scrobble has no album name.')
      const next = await addAndLinkLastfmAlbum({
        apiBaseUrl,
        source: { artistName: group.artistName, albumName: group.albumName },
        item,
        identities: added.current,
        onAlbumReady: (albumId) =>
          setOperations((current) =>
            current.map((operation) =>
              operation.key === key ? { ...operation, albumId } : operation,
            ),
          ),
      })
      client.setQueryData(['lastfm-sync'], next)
      void Promise.all([
        invalidateScrobbleLinks(client),
        invalidateManualMediaAddition(client, 'album'),
      ])
    },
    onSuccess: (_, operation) => {
      setOperations((current) =>
        current.map((item) =>
          item.key === operation.key ? { ...item, done: true } : item,
        ),
      )
    },
    onError: (error, operation) => {
      const message = errorMessage(error, 'Could not add and link the album.')
      setOperations((current) =>
        current.map((item) =>
          item.key === operation.key
            ? {
                ...item,
                error: message,
                albumId: added.current.get(operation.item.externalId) ?? null,
              }
            : item,
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
    const operation = {
      group,
      item,
      key,
      error: null,
      albumId: added.current.get(item.externalId) ?? null,
      done: false,
    }
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
  return (
    <>
      {linkResult && (
        <Notice
          action={
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setLinkResult(null)}
            >
              Dismiss
            </Button>
          }
        >
          <span className="ds-cell-id" role="status">
            <ButtonFeedbackLabel
              feedback={{ phase: 'done', label: linkResult.label }}
            />
          </span>{' '}
          {linkResult.albumId ? (
            <DetailLink kind="album" id={linkResult.albumId}>
              {linkResult.group.albumName}
            </DetailLink>
          ) : (
            linkResult.group.albumName
          )}
        </Notice>
      )}
      {operations.length > 0 && (
        <div className="sec-notices">
          {operations.map((operation) => (
            <Notice
              key={operation.key}
              tone={operation.error ? 'danger' : undefined}
              action={
                <span className="ds-actions">
                  {operation.error && operation.albumId && (
                    <Button
                      size="xs"
                      feedback={additionFeedback(operation)}
                      onClick={() => start(operation.group, operation.item)}
                    >
                      Retry linking
                    </Button>
                  )}
                  {operation.error && !operation.albumId && (
                    <Button
                      size="xs"
                      onClick={() =>
                        onSelectionChange({
                          group: operation.group,
                          mode: 'new',
                        })
                      }
                    >
                      Review
                    </Button>
                  )}
                  {(operation.error || operation.done) && (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        setOperations((current) =>
                          current.filter((item) => item.key !== operation.key),
                        )
                      }
                    >
                      Dismiss
                    </Button>
                  )}
                </span>
              }
            >
              <span className="ds-cell-id" role="status">
                <ButtonFeedbackLabel feedback={additionFeedback(operation)} />
              </span>{' '}
              {operation.albumId ? (
                <DetailLink kind="album" id={operation.albumId}>
                  {operation.item.title}
                </DetailLink>
              ) : (
                operation.item.title
              )}{' '}
              {operation.error}
            </Notice>
          ))}
        </div>
      )}
      {selection && (
        <LastfmLinkPanel
          key={lastfmLinkKey(selection.group)}
          group={selection.group}
          initialMode={selection.mode}
          onClose={() => onSelectionChange(null)}
          onChanged={(label, albumId) =>
            setLinkResult({ label, albumId, group: selection.group })
          }
          onChoose={(item) => start(selection.group, item)}
          backgroundError={selectedOperation?.error ?? undefined}
          backgroundPending={
            selectedOperation !== undefined &&
            !selectedOperation.done &&
            selectedOperation.error === null
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
