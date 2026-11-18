'use client'

import {
  ArtistIdentifierSourcePageSchema,
  type ArtistIdentifier,
  type ArtistIdentifierSource,
} from '@repo/schemas/artist-profiles'
import type { ProviderSummary } from '@repo/schemas/provider'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Button } from '@repo/ui/components/ui/button'
import { TableState } from '@repo/ui/components/ui/table'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { fetchApiData } from '@/utils/api'
import { artistProviderLabel } from '@/utils/artist-providers'
import { DetailLink } from './detail-link'
import { useConfig } from './providers'
import {
  SecondaryCell,
  SecondaryTableScroll,
  SecondaryVirtualRows,
} from './secondary-table'

export function ArtistIdentifierSourceRow({
  source,
  index,
  catalog,
}: {
  source: ArtistIdentifierSource
  index: number
  catalog?: readonly ProviderSummary[]
}) {
  const label = artistProviderLabel(source.provider, catalog)
  const kind =
    source.kind === 'artist'
      ? 'Artist profile'
      : source.kind === 'album'
        ? 'Album'
        : 'Track'
  return (
    <tr aria-rowindex={index + 2}>
      <td>
        <div className="ds-cell-two">
          <SecondaryCell
            text={`${kind}: ${source.title}`}
            label={`Source details for ${source.title}`}
          >
            <DetailLink
              kind={source.kind}
              id={source.id}
              tab={source.kind === 'track' ? undefined : 'sources'}
            >
              {source.title}
            </DetailLink>
          </SecondaryCell>
          <span className="ds-cell-sub ds-muted">
            {kind} ·{' '}
            {source.jobId ? (
              <DetailLink kind="job" id={source.jobId}>
                {label}
              </DetailLink>
            ) : (
              label
            )}
          </span>
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
  catalog,
}: {
  id: string
  identifier: ArtistIdentifier
  catalog?: readonly ProviderSummary[]
}) {
  const { apiBaseUrl } = useConfig()
  const query = useVirtualTable({
    queryKey: ['artist', id, 'identifier-sources', identifier.provider],
    pageSize: 25,
    rowHeight: 44,
    loadPage: (page, size, signal) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/artists/${encodeURIComponent(id)}/sources/${encodeURIComponent(identifier.provider)}/identifiers?${new URLSearchParams({ page: String(page), size: String(size) })}`,
        ArtistIdentifierSourcePageSchema,
        { signal },
      ),
  })
  const label = `Sources for ${artistProviderLabel(identifier.provider, catalog)} identifier`
  return (
    <div className="data-stack">
      <p className="ds-muted">
        {identifier.status === 'conflict'
          ? 'Conflicting stored identifiers. Choose an ID before refreshing.'
          : identifier.status === 'confirmed'
            ? 'Current ID from artist enrichment.'
            : 'From stored sources.'}
      </p>
      {query.isError && (
        <Notice
          tone="danger"
          action={
            <Button size="xs" onClick={query.retry}>
              Retry
            </Button>
          }
        >
          Could not load identifier sources.
        </Notice>
      )}
      <SecondaryTableScroll
        ref={query.scroller}
        onScroll={query.onScroll}
        className="table-scroll-bounded"
        role="region"
        aria-label={label}
        aria-busy={query.isFetching}
      >
        <table
          className="ds-table"
          data-layout="fixed"
          data-rows="two"
          aria-label={label}
          aria-rowcount={query.hasTotal ? query.total + 1 : undefined}
        >
          <thead>
            <tr>
              <th>Source</th>
              <th style={{ width: '34%' }}>Identifier</th>
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
                  catalog={catalog}
                />
              )}
            />
          </tbody>
        </table>
      </SecondaryTableScroll>
    </div>
  )
}
