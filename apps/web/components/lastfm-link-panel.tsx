'use client'

import Link from 'next/link'
import { useEffect, useId, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { type LastfmLinkGroup } from '@repo/schemas/lastfm'
import { Button } from '@repo/ui/components/ui/button'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@repo/ui/components/ui/tabs'
import {
  lastfmLinkReasonLabels,
  lastfmLinkStrategyLabels,
} from '@/utils/lastfm-sync'
import { AlbumPicker, useLastfmLinkUpdate } from './lastfm-link-controls'
import { errorMessage } from './lastfm-sync'
import { ManualMediaSearch } from './manual-media-add'

export type LastfmLinkPanelMode = 'library' | 'new'

export default function LastfmLinkPanel({
  group,
  initialMode = 'library',
  onClose,
}: {
  group: LastfmLinkGroup
  initialMode?: LastfmLinkPanelMode
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const update = useLastfmLinkUpdate()
  const [adding, setAdding] = useState(false)
  const [mode, setMode] = useState<LastfmLinkPanelMode>(initialMode)
  const busy = adding || update.isPending
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
        if (!busy) onClose()
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (!busy && event.target === event.currentTarget) onClose()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="tag-drawer-inner">
        <div className="detail-topbar">
          <span>Scrobble link</span>
          <button
            type="button"
            aria-label="Close scrobble link"
            disabled={busy}
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
                    disabled={busy}
                    onPick={chooseLibraryAlbum}
                  />
                </TabsContent>
                <TabsContent value="new" className="mt-3">
                  <ManualMediaSearch
                    mediaType="album"
                    initialQuery={`${group.artistName} ${albumName}`.slice(
                      0,
                      200,
                    )}
                    existingActionLabel="Link"
                    disabled={update.isPending}
                    onPendingChange={setAdding}
                    onAdded={link}
                  />
                </TabsContent>
              </Tabs>
            </>
          )}
        </div>
      </div>
    </dialog>
  )
}
