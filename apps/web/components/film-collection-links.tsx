'use client'

import { Fragment } from 'react'
import { sameBrowseFilter, type BrowseFilter } from '@repo/schemas/browse'
import type { FilmDetail } from '@repo/schemas/media'
import { filterModeClass } from './browse-controls'
import { DetailLink } from './detail-link'
import MetadataSourceControl from './metadata-source-control'

export function FilmCollectionLinks({
  item,
  activeFilters,
  pills = false,
}: {
  item: Pick<FilmDetail, 'id' | 'playlists' | 'collectionSources'>
  activeFilters?: BrowseFilter[]
  pills?: boolean
}) {
  const collections = item.playlists.filter(({ kind }) => kind === 'collection')
  return (
    <span
      className={pills ? 'detail-tags detail-tags-scroll' : 'inline-values'}
    >
      {collections.map(({ id, name }, index) => {
        const active = activeFilters?.find((filter) =>
          sameBrowseFilter(filter, { field: 'collection', value: name }),
        )
        const pillClass = `metadata-tag${active ? ` ${filterModeClass(active.mode)}` : ''}`
        const label = id ? (
          <DetailLink
            className={
              pills ? pillClass : 'pointer-events-auto hover:underline'
            }
            kind="collection"
            id={id}
            title={`Open ${name}`}
          >
            {name}
          </DetailLink>
        ) : (
          <span className={pills ? pillClass : undefined}>{name}</span>
        )
        return (
          <Fragment key={id ?? name}>
            {pills ? (
              <span className="inline-flex items-center">
                {label}
                <MetadataSourceControl
                  field="collection"
                  name={name}
                  mediaId={item.id}
                  collectionSources={item.collectionSources}
                />
              </span>
            ) : (
              <>
                {index > 0 && ', '}
                {label}
              </>
            )}
          </Fragment>
        )
      })}
    </span>
  )
}
