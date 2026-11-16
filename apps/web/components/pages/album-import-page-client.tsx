'use client'

import { PageHead } from '@repo/ui/components/ds/toolbar'
import AlbumImportWorkflow from '@/components/album-import-workflow'
import { ImportStatusNotice } from '@/components/imports-workspace'

export default function AlbumImportPageClient({
  kind,
}: {
  kind: 'csv' | 'spotify'
}) {
  return (
    <section className="sec-page">
      <PageHead
        title={kind === 'spotify' ? 'Spotify saved albums' : 'Album CSV'}
      />
      <div className="sec-notices">
        <ImportStatusNotice />
      </div>
      <AlbumImportWorkflow key={kind} kind={kind} />
    </section>
  )
}
