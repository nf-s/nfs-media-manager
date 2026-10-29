'use client'

import AlbumImportWorkflow from '@/components/album-import-workflow'
import { ImportStatusNotice } from '@/components/imports-workspace'

export default function AlbumImportPageClient({
  kind,
}: {
  kind: 'csv' | 'spotify'
}) {
  return (
    <section className="admin-page imports-page">
      <h1>{kind === 'spotify' ? 'Spotify saved albums' : 'Album CSV'}</h1>
      <ImportStatusNotice />
      <AlbumImportWorkflow key={kind} kind={kind} />
    </section>
  )
}
