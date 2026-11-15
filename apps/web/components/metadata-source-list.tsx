import React from 'react'
import type { TagProvenancePage } from '@repo/schemas/tags'
import ServiceIconLinks from './service-icon-links'
import { relevantTagSources } from '../utils/tag-actions'

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
