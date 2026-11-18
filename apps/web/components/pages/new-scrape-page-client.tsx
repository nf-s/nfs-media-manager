'use client'

import { usePathname, useSearchParams } from 'next/navigation'
import { State } from '@repo/ui/components/ds/feedback'
import { Select } from '@repo/ui/components/ds/toolbar'
import { useMediaProviders } from '@/components/film-provider-selection'
import FilmSelectionTable from '@/components/film-selection-table'
import ArtistMetadataTable from '@/components/artist-metadata-table'
import TrackMetadataTable from '@/components/track-metadata-table'
import { useRailLibraryView } from '@/components/media-scope'
import { metadataLibrary } from '@/utils/job-media-scope'
import { scopedHref, type MediaScope } from '@/utils/media-scope'

const libraries = [
  { value: 'album', label: 'Albums' },
  { value: 'track', label: 'Tracks' },
  { value: 'film', label: 'Films' },
  { value: 'artist', label: 'Artists' },
]

/** Metadata selects from one library at a time. */
function LibraryFilter({ value }: { value: string }) {
  const path = usePathname()
  return (
    <Select
      aria-label="Library"
      value={value}
      onChange={(event) =>
        // Next keeps its router in step with history entries pushed here.
        window.history.pushState(
          null,
          '',
          scopedHref(path, metadataLibrary(event.target.value, value)),
        )
      }
    >
      {libraries.map((library) => (
        <option key={library.value} value={library.value}>
          {library.label}
        </option>
      ))}
    </Select>
  )
}

export default function NewScrapePageClient() {
  const params = useSearchParams()
  const rail = useRailLibraryView()
  const library = metadataLibrary(params.get('mediaType'), rail)
  const filter = <LibraryFilter value={library} />
  if (library === 'track')
    return (
      <section className="ops-fill" aria-label="Track metadata">
        <TrackMetadataTable filters={filter} />
      </section>
    )
  if (library === 'artist')
    return (
      <section className="ops-fill" aria-label="Artist metadata">
        <ArtistMetadataTable key="artist" filters={filter} />
      </section>
    )
  return <MediaMetadataPage key={library} mediaType={library} filter={filter} />
}

function MediaMetadataPage({
  mediaType,
  filter,
}: {
  mediaType: MediaScope
  filter: React.ReactNode
}) {
  const selection = useMediaProviders(mediaType)
  return (
    <section
      className="ops-fill"
      aria-label={`${mediaType === 'album' ? 'Album' : 'Film'} metadata`}
    >
      {selection.isPending && <State size="sm" title="Loading providers..." />}
      {selection.isError && (
        <State
          size="sm"
          error
          title="Could not load providers. Reload to try again."
        />
      )}
      {!selection.isPending && !selection.isError && (
        <FilmSelectionTable
          providers={selection.providers}
          mediaType={mediaType}
          filters={filter}
        />
      )}
    </section>
  )
}
