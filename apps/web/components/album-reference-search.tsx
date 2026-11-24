'use client'

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { LibraryAction } from '@repo/ui/components/ds/library-action'
import { useDetailInspector } from './detail-inspector-context'
import ManualMediaAdd from './manual-media-add'

export function AlbumReferenceSearchDialog({
  query,
  onClose,
}: {
  query: string
  onClose: () => void
}) {
  const inspector = useDetailInspector()

  return createPortal(
    <ManualMediaAdd
      mediaType="album"
      initialQuery={query}
      onClose={onClose}
      onAdded={(id) => {
        onClose()
        if (inspector) inspector.open({ kind: 'album', id })
        else window.location.assign(`/albums/${encodeURIComponent(id)}`)
      }}
    />,
    document.body,
  )
}

/** A recorded album name opens the chooser so the user can confirm the release. */
export function AlbumReferenceSearch({
  name,
  query,
}: {
  name: string
  query: string
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <LibraryAction
        name={name}
        kind="album"
        action="find"
        onAdd={() => setOpen(true)}
      />
      {open && (
        <AlbumReferenceSearchDialog
          query={query}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
