'use client'

import { useMediaProviders } from '@/components/film-provider-selection'
import FilmSelectionTable from '@/components/film-selection-table'
import { useMediaScope } from '@/components/media-scope'

export default function NewScrapePageClient() {
  const mediaType = useMediaScope()
  const selection = useMediaProviders(mediaType)
  return (
    <section className="admin-page film-selection-page table-workspace">
      <h1>{mediaType === 'album' ? 'Album' : 'Film'} metadata</h1>
      {selection.isPending && <p className="muted">Loading providers...</p>}
      {selection.isError && (
        <p role="alert">Could not load providers. Reload to try again.</p>
      )}
      {!selection.isPending && !selection.isError && (
        <FilmSelectionTable
          key={mediaType}
          providers={selection.providers}
          mediaType={mediaType}
        />
      )}
    </section>
  )
}
