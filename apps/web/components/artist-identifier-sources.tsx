'use client'

import {
  ArtistIdentifierSourcePageSchema,
  type ArtistIdentifier,
  type ArtistIdentifierSource,
} from '@repo/schemas/artist-profiles'
import { TableState } from '@repo/ui/components/ui/table'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { fetchApiData } from '@/utils/api'
import { DetailLink } from './detail-link'
import { useConfig } from './providers'
import {
  SecondaryCell,
  SecondaryTableScroll,
  SecondaryVirtualRows,
} from './secondary-table'

export const artistProviderLabels = {
  spotify: 'Spotify',
  musicbrainz: 'MusicBrainz',
  discogs: 'Discogs',
  lastfm: 'Last.fm',
}

export function ArtistIdentifierSourceRow({
  source,
  index,
}: {
  source: ArtistIdentifierSource
  index: number
}) {
  const kind =
    source.kind === 'artist'
      ? 'Artist profile'
      : source.kind === 'album'
        ? 'Album'
        : 'Track'
  return (
    <tr aria-rowindex={index + 2} style={{ height: 48 }}>
      <td>
        <SecondaryCell
          text={`${kind}: ${source.title}`}
          label={`Source details for ${source.title}`}
        >
          <DetailLink
            kind={source.kind}
            id={source.id}
            tab={source.kind === 'track' ? undefined : 'sources'}
            className="underline"
          >
            {source.title}
          </DetailLink>
        </SecondaryCell>
        <div className="quiet text-xs">
          {kind} ·{' '}
          {source.jobId ? (
            <DetailLink kind="job" id={source.jobId} className="underline">
              {artistProviderLabels[source.provider]}
            </DetailLink>
          ) : (
            artistProviderLabels[source.provider]
          )}
        </div>
      </td>
      <td>
        <SecondaryCell>{source.externalId}</SecondaryCell>
      </td>
    </tr>
  )
}

/** Read stored provenance only when its identifier disclosure is opened. */
export function ArtistIdentifierSources({
  id,
  identifier,
}: {
  id: string
  identifier: ArtistIdentifier
}) {
  const { apiBaseUrl } = useConfig()
  const query = useVirtualTable({
    queryKey: ['artist', id, 'identifier-sources', identifier.provider],
    pageSize: 25,
    rowHeight: 48,
    loadPage: (page, size, signal) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/artists/${encodeURIComponent(id)}/sources/${identifier.provider}/identifiers?${new URLSearchParams({ page: String(page), size: String(size) })}`,
        ArtistIdentifierSourcePageSchema,
        { signal },
      ),
  })
  const label = `Sources for ${artistProviderLabels[identifier.provider]} identifier`
  return (
    <div className="w-[380px] max-w-full space-y-2">
      <p>
        {identifier.status === 'conflict'
          ? 'Conflicting stored identifiers. Choose an ID before refreshing.'
          : identifier.status === 'confirmed'
            ? 'Current ID from artist enrichment.'
            : 'From stored sources.'}
      </p>
      {query.isError && (
        <p role="alert">
          Could not load identifier sources.{' '}
          <button type="button" onClick={query.retry} className="underline">
            Retry
          </button>
        </p>
      )}
      <SecondaryTableScroll
        ref={query.scroller}
        onScroll={query.onScroll}
        className="table-scroll-bounded max-h-64"
        role="region"
        aria-label={label}
        aria-busy={query.isFetching}
      >
        <table
          className="ds-table w-full table-fixed"
          aria-label={label}
          aria-rowcount={query.hasTotal ? query.total + 1 : undefined}
        >
          <colgroup>
            <col className="w-2/3" />
            <col className="w-1/3" />
          </colgroup>
          <thead>
            <tr>
              <th>Source</th>
              <th>Identifier</th>
            </tr>
          </thead>
          <tbody>
            {query.hasTotal && !query.total && (
              <TableState colSpan={2}>No stored identifier sources.</TableState>
            )}
            <SecondaryVirtualRows
              window={query}
              colSpan={2}
              renderRow={(source, index) => (
                <ArtistIdentifierSourceRow
                  key={index}
                  source={source}
                  index={index}
                />
              )}
            />
          </tbody>
        </table>
      </SecondaryTableScroll>
    </div>
  )
}
