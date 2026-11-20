import React, { type Ref, type UIEventHandler } from 'react'
import type {
  ItemTagProvenancePage,
  TagProvenancePage,
} from '@repo/schemas/tags'
import ServiceIconLinks from './service-icon-links'
import { DetailLink } from './detail-link'
import { relevantTagSources } from '../utils/tag-actions'
import { TableHead, TableState } from '@repo/ui/components/ui/table'
import { formatCount } from '@repo/ui/lib/format'
import {
  SecondaryCell,
  SecondaryTableScroll,
  SecondaryVirtualRows,
  useTableWidths,
  type SecondaryVirtualWindow,
} from './secondary-table'

type Source =
  | TagProvenancePage['items'][number]
  | ItemTagProvenancePage['items'][number]

function tagSourceLabel(source: Source, compact = false) {
  if ('originType' in source) {
    const { sourceLabel, providerLabel } = source
    if (sourceLabel && providerLabel && sourceLabel !== providerLabel)
      return `${sourceLabel} via ${providerLabel}`
    return sourceLabel ?? providerLabel ?? 'Unknown source'
  }
  if (compact) return source.providerLabel ?? source.source ?? '-'
  if (!source.source || source.source === 'unknown')
    return source.providerLabel ?? 'Unknown source'
  return source.provider &&
    source.providerLabel &&
    source.source !== source.provider
    ? `${source.source} via ${source.providerLabel}`
    : source.source
}

export function MetadataSourceLinks({
  items,
}: {
  items: TagProvenancePage['items']
}) {
  const sources = relevantTagSources(items)
  if (!sources.length)
    return <p className="ds-muted">No source links available.</p>
  return (
    <ul className="flex flex-wrap gap-3" aria-label="Source links">
      {sources.map((source) => {
        if (!source.link) return null
        const description =
          source.linkKind === 'tag'
            ? `View tag on ${source.link.providerLabel}`
            : `View ${source.itemTitle ?? 'film'} on ${source.link.providerLabel}${source.linkKind === 'provider-item' ? ' (import provider)' : ''}`
        return (
          <li key={source.link.url}>
            <span className="ds-cell-id" title={description}>
              {source.link.providerLabel}
              <ServiceIconLinks
                links={[
                  {
                    provider: source.link.provider,
                    label: source.link.providerLabel,
                    url: source.link.url,
                  },
                ]}
              />
            </span>
          </li>
        )
      })}
    </ul>
  )
}

export default function MetadataSourceList({ items }: { items: Source[] }) {
  return (
    <ul className="data-stack">
      {items.map((source) => (
        <li
          key={JSON.stringify([
            source.provider,
            source.source,
            source.rawName,
            source.sourceId,
            source.kind,
            ...('originType' in source
              ? [source.originType, source.originId, source.snapshotId]
              : []),
          ])}
        >
          <strong className="data-wrap">{source.rawName}</strong>
          <div className="ds-muted">
            {tagSourceLabel(source)}
            {' · '}
            {source.kind}
            {source.onMedia === false && ' · Elsewhere in library'}
          </div>
          {source.sourceId && (
            <div className="ds-muted data-wrap">ID: {source.sourceId}</div>
          )}
          {'releaseSupport' in source && source.releaseSupport && (
            <div className="ds-muted">
              {formatCount(source.releaseSupport.matchingReleases)} of{' '}
              {formatCount(source.releaseSupport.taggedReleases)} tagged
              releases
            </div>
          )}
          {source.link ? (
            <span className="ds-cell-id">
              {source.linkKind === 'tag'
                ? `View tag on ${source.link.providerLabel}`
                : `View ${source.itemTitle ?? ('originType' in source ? source.originTitle : 'film')} on ${source.link.providerLabel}${source.linkKind === 'provider-item' ? ' (import provider)' : ''}`}
              <ServiceIconLinks
                links={[
                  {
                    provider: source.link.provider,
                    label: source.link.providerLabel,
                    url: source.link.url,
                  },
                ]}
              />
            </span>
          ) : (
            <span className="ds-muted">
              {'originType' in source
                ? 'No source link was saved.'
                : 'Source cannot be identified from this import.'}
            </span>
          )}
          {source.linkNote && <div className="ds-muted">{source.linkNote}</div>}
          {source.jobId && (
            <DetailLink kind="job" id={source.jobId}>
              View job
            </DetailLink>
          )}
        </li>
      ))}
    </ul>
  )
}

/** Narrow enough for the 330px source popover; the source takes any room left. */
const tagSourceColumns = [
  { key: 'tag', label: 'Stored tag', width: 160 },
  { key: 'source', label: 'Source', width: 140 },
]

export function VirtualTagSources({
  query,
  label,
  linksOnly = false,
  showArtist = false,
}: {
  query: SecondaryVirtualWindow<Source> & {
    total: number
    hasTotal: boolean
    isFetching: boolean
    scroller: Ref<HTMLDivElement>
    onScroll: UIEventHandler<HTMLDivElement>
  }
  label: string
  linksOnly?: boolean
  showArtist?: boolean
}) {
  const widths = useTableWidths('tag-sources', tagSourceColumns)
  const layout = widths.layout(tagSourceColumns.map((column) => column.key))
  return (
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
        aria-label={label}
        aria-rowcount={query.hasTotal ? query.total + 1 : undefined}
        {...layout.table}
      >
        {layout.colgroup}
        <thead>
          <tr>
            {tagSourceColumns.map((column) => (
              <TableHead key={column.key} resizer={widths.resizer(column.key)}>
                {showArtist && column.key === 'tag' ? 'Artist' : column.label}
              </TableHead>
            ))}
          </tr>
        </thead>
        <tbody>
          {query.hasTotal && !query.total && (
            <TableState colSpan={2}>No source metadata was saved.</TableState>
          )}
          <SecondaryVirtualRows
            window={query}
            colSpan={2}
            renderRow={(source, index) => {
              const artist =
                showArtist &&
                'originType' in source &&
                source.originType === 'artist'
                  ? source
                  : undefined
              return (
                <tr key={index} aria-rowindex={index + 2}>
                  <td>
                    <SecondaryCell
                      text={artist?.originTitle ?? source.rawName}
                      details={
                        linksOnly ? undefined : (
                          <MetadataSourceList items={[source]} />
                        )
                      }
                      label={`Source details for ${artist?.originTitle ?? source.rawName}`}
                    >
                      {artist ? (
                        <DetailLink kind="artist" id={artist.originId}>
                          {artist.originTitle}
                        </DetailLink>
                      ) : (
                        source.rawName
                      )}
                    </SecondaryCell>
                  </td>
                  <td>
                    <div className="secondary-cell-actions">
                      <SecondaryCell>
                        {tagSourceLabel(source, true)}
                      </SecondaryCell>
                      {source.link &&
                        (!linksOnly || source.onMedia !== false) && (
                          <ServiceIconLinks
                            links={[
                              {
                                provider: source.link.provider,
                                label: source.link.providerLabel,
                                url: source.link.url,
                              },
                            ]}
                          />
                        )}
                      {source.jobId &&
                        (!linksOnly || source.onMedia !== false) && (
                          <DetailLink
                            className="ds-muted"
                            kind="job"
                            id={source.jobId}
                          >
                            Job
                          </DetailLink>
                        )}
                    </div>
                  </td>
                </tr>
              )
            }}
          />
        </tbody>
      </table>
    </SecondaryTableScroll>
  )
}
