'use client'

import { Fragment } from 'react'
import { sameBrowseFilter, type BrowseFilter } from '@repo/schemas/browse'
import type { AlbumDetail, FilmDetail } from '@repo/schemas/media'
import type { MediaScope } from '@/utils/media-scope'
import { EmptyValue, Pill, PillLabel, Pills } from '@repo/ui/components/ds/pill'
import { browseFilterHref } from '@/utils/browse-items'
import { workspaceTabLinkProps } from '@/utils/workspace-tab-destination'
import { DetailLink } from './detail-link'

/**
 * The stored collections an item belongs to. Each opens the collection; as
 * pills, a collection the browse filters use shows in its filter mode.
 */
export function CollectionLinks({
  item,
  mediaType,
  activeFilters,
  filterHref,
  pills = false,
}: {
  item: Pick<AlbumDetail | FilmDetail, 'playlists'>
  mediaType: MediaScope
  activeFilters?: BrowseFilter[]
  filterHref?: (filter: BrowseFilter) => string
  pills?: boolean
}) {
  const collections = item.playlists.filter(({ kind }) => kind === 'collection')
  function nameOnlyDestination(name: string) {
    const filter = { field: 'collection', value: name }
    const path = mediaType === 'album' ? '/albums' : '/films'
    return {
      ...workspaceTabLinkProps(
        filterHref?.(filter) ?? browseFilterHref(path, [filter]),
        name,
      ),
      tabIndex: 0,
    }
  }
  if (!collections.length) return pills ? null : <EmptyValue />
  if (pills)
    return (
      <Pills wrap label="Collections">
        {collections.map(({ id, name }) => {
          const active = activeFilters?.find((filter) =>
            sameBrowseFilter(filter, { field: 'collection', value: name }),
          )
          const mode = active ? (active.mode ?? 'any') : undefined
          return id ? (
            <Pill asChild size="md" mode={mode} key={id}>
              <DetailLink
                kind="collection"
                mediaType={mediaType}
                id={id}
                title={`Open ${name}`}
              >
                <PillLabel>{name}</PillLabel>
              </DetailLink>
            </Pill>
          ) : (
            <Pill
              size="md"
              mode={mode}
              key={name}
              {...nameOnlyDestination(name)}
            >
              {name}
            </Pill>
          )
        })}
      </Pills>
    )
  return (
    <span className="inline-values">
      {collections.map(({ id, name }, index) => (
        <Fragment key={id ?? name}>
          {index > 0 && ', '}
          {id ? (
            <DetailLink
              className="pointer-events-auto hover:underline"
              kind="collection"
              mediaType={mediaType}
              id={id}
              title={`Open ${name}`}
            >
              {name}
            </DetailLink>
          ) : (
            <span {...nameOnlyDestination(name)}>{name}</span>
          )}
        </Fragment>
      ))}
    </span>
  )
}
