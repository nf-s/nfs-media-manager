'use client'

import { ReadButton } from '@/components/read-button'
import {
  ArtistIdentifierSourcePageSchema,
  type ArtistIdentifier,
  type ArtistIdentifierSource,
} from '@repo/schemas/artist-profiles'
import type { ProviderSummary } from '@repo/schemas/provider'
import { Notice } from '@repo/ui/components/ds/feedback'
import { TableHead, TableState } from '@repo/ui/components/ui/table'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { fetchApiData } from '@/utils/api'
import { artistProviderLabel } from '@/utils/artist-providers'
import { DetailLink } from './detail-link'
import { useConfig } from './providers'
import {
  SecondaryCell,
  SecondaryTableScroll,
  SecondaryVirtualRows,
  useTableWidths,
} from './secondary-table'

/** Fits the 600px detail inspector; the identifier takes any room left. */
const identifierSourceColumns = [
  { key: 'source', label: 'Source', width: 300 },
  { key: 'identifier', label: 'Identifier', width: 200 },
]

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
  const widths = useTableWidths(
    'artist-identifier-sources',
    identifierSourceColumns,
  )
  const layout = widths.layout(
    identifierSourceColumns.map((column) => column.key),
  )
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
            <ReadButton size="xs" read={query.retry}>
              Retry
            </ReadButton>
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
          data-rows="two"
          aria-label={label}
          aria-rowcount={query.hasTotal ? query.total + 1 : undefined}
          {...layout.table}
        >
          {layout.colgroup}
          <thead>
            <tr>
              {identifierSourceColumns.map((column) => (
                <TableHead
                  key={column.key}
                  resizer={widths.resizer(column.key)}
                >
                  {column.label}
                </TableHead>
              ))}
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
