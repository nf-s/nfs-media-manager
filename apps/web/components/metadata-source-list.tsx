import React, { type Ref, type UIEventHandler } from 'react'
import type { TagProvenancePage } from '@repo/schemas/tags'
import ServiceIconLinks from './service-icon-links'
import { relevantTagSources } from '../utils/tag-actions'
import { TableState } from '@repo/ui/components/ui/table'
import {
  SecondaryCell,
  SecondaryTableScroll,
  SecondaryVirtualRows,
  type SecondaryVirtualWindow,
} from './secondary-table'

export function MetadataSourceLinks({
  items,
}: {
  items: TagProvenancePage['items']
}) {
  const sources = relevantTagSources(items)
  if (!sources.length)
    return <p className="quiet text-xs">No source links available.</p>
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-2" aria-label="Source links">
      {sources.map((source) => {
        if (!source.link) return null
        const description =
          source.linkKind === 'tag'
            ? `View tag on ${source.link.providerLabel}`
            : `View ${source.itemTitle ?? 'film'} on ${source.link.providerLabel}${source.linkKind === 'provider-item' ? ' (import provider)' : ''}`
        return (
          <li key={source.link.url}>
            <span
              className="inline-flex items-center gap-1 text-xs"
              title={description}
            >
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

export default function MetadataSourceList({
  items,
}: {
  items: TagProvenancePage['items']
}) {
  return (
    <ul className="grid gap-2.5">
      {items.map((source) => (
        <li
          key={JSON.stringify([
            source.provider,
            source.source,
            source.rawName,
            source.sourceId,
            source.kind,
          ])}
        >
          <div className="break-words font-medium">{source.rawName}</div>
          <div className="quiet text-xs">
            {source.source && source.source !== 'unknown'
              ? source.source
              : (source.providerLabel ?? 'Unknown source')}
            {source.source &&
              source.source !== 'unknown' &&
              source.provider &&
              source.source !== source.provider &&
              ` via ${source.providerLabel}`}
            {' · '}
            {source.kind}
            {source.onMedia === false && ' · Elsewhere in library'}
          </div>
          {source.sourceId && (
            <div className="quiet break-all text-xs">ID: {source.sourceId}</div>
          )}
          {source.link ? (
            <span className="inline-flex items-center gap-1 text-xs">
              {source.linkKind === 'tag'
                ? `View tag on ${source.link.providerLabel}`
                : `View ${source.itemTitle ?? 'film'} on ${source.link.providerLabel}${source.linkKind === 'provider-item' ? ' (import provider)' : ''}`}
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
            <span className="quiet text-xs">
              Source cannot be identified from this import.
            </span>
          )}
          {source.linkNote && (
            <div className="quiet text-xs">{source.linkNote}</div>
          )}
        </li>
      ))}
    </ul>
  )
}

type Source = TagProvenancePage['items'][number]

export function VirtualTagSources({
  query,
  label,
  linksOnly = false,
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
}) {
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
      >
        <thead>
          <tr>
            <th>Stored tag</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {query.hasTotal && !query.total && (
            <TableState colSpan={2}>No source metadata was saved.</TableState>
          )}
          <SecondaryVirtualRows
            window={query}
            colSpan={2}
            renderRow={(source, index) => (
              <tr key={index} aria-rowindex={index + 2}>
                <td>
                  <SecondaryCell
                    text={source.rawName}
                    details={
                      linksOnly ? undefined : (
                        <MetadataSourceList items={[source]} />
                      )
                    }
                    label={`Source details for ${source.rawName}`}
                  >
                    {source.rawName}
                  </SecondaryCell>
                </td>
                <td>
                  <div className="secondary-cell-actions">
                    <SecondaryCell>
                      {source.providerLabel ?? source.source ?? '-'}
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
                  </div>
                </td>
              </tr>
            )}
          />
        </tbody>
      </table>
    </SecondaryTableScroll>
  )
}
