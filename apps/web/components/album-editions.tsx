'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { LibraryChange } from '@repo/schemas/library-changes'
import type { AlbumDetail, AlbumEdition } from '@repo/schemas/media'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { EmptyValue } from '@repo/ui/components/ds/pill'
import { Button } from '@repo/ui/components/ui/button'
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui/components/ui/table'
import { formatCount } from '@repo/ui/lib/format'
import { separateAlbumEdition } from '@/utils/album-merges'
import { AlbumChangeNotice, invalidateAlbumChange } from './album-merge-review'
import { DetailLink } from './detail-link'
import { errorMessage } from './lastfm-sync'
import { useConfig } from './providers'
import { SecondaryTableScroll, useTableWidths } from './secondary-table'

const editionColumns = [
  { key: 'album', label: 'Album', width: 220, fill: true },
  { key: 'released', label: 'Released', width: 96 },
  { key: 'tracks', label: 'Tracks', width: 64 },
  { key: 'scrobbles', label: 'Scrobbles', width: 84 },
]
/** Room for Separate. */
const actionsWidth = 96

/** The albums of one record, each a link, with Separate where it applies. */
function EditionsTable({
  label,
  albums,
  separate,
}: {
  label: string
  albums: readonly AlbumEdition[]
  /** Separate for each row; the rows have none when omitted. */
  separate?: { pending: boolean; onSeparate: (albumId: string) => void }
}) {
  const widths = useTableWidths('album-editions', editionColumns)
  const layout = widths.layout([
    ...editionColumns.map((column) => column.key),
    ...(separate ? [actionsWidth] : []),
  ])
  return (
    <SecondaryTableScroll
      className="dtl-bounded"
      role="region"
      aria-label={label}
    >
      <table className="ds-table" aria-label={label} {...layout.table}>
        {layout.colgroup}
        <TableHeader>
          <TableRow>
            <TableHead resizer={widths.resizer('album')}>Album</TableHead>
            <TableHead resizer={widths.resizer('released')}>Released</TableHead>
            <TableHead align="end" resizer={widths.resizer('tracks')}>
              Tracks
            </TableHead>
            <TableHead align="end" resizer={widths.resizer('scrobbles')}>
              Scrobbles
            </TableHead>
            {separate && (
              <TableHead align="end">
                <span className="sr-only">Actions</span>
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {albums.map((album) => (
            <TableRow key={album.id}>
              <TableCell>
                <DetailLink
                  className="ds-cell-title"
                  kind="album"
                  id={album.id}
                  title={album.title}
                >
                  {album.title}
                </DetailLink>
              </TableCell>
              <TableCell>
                {album.releaseDate ? (
                  <span className="ds-num">
                    {album.releaseDate.slice(0, 10)}
                  </span>
                ) : (
                  <EmptyValue />
                )}
              </TableCell>
              <TableCell align="end">{formatCount(album.trackCount)}</TableCell>
              <TableCell align="end">{formatCount(album.scrobbles)}</TableCell>
              {separate && (
                <TableCell align="end">
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={separate.pending}
                    aria-label={`Separate ${album.title}`}
                    onClick={() => separate.onSeparate(album.id)}
                  >
                    Separate
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </table>
    </SecondaryTableScroll>
  )
}

/**
 * The record an album belongs to: a first album lists its editions, an
 * edition names its first album. Separate gives an edition its own record
 * again; the result line offers Undo.
 */
export default function AlbumEditions({ album }: { album: AlbumDetail }) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [change, setChange] = useState<LibraryChange | null>(null)
  const separate = useMutation({
    retry: false,
    mutationFn: (albumId: string) => separateAlbumEdition(apiBaseUrl, albumId),
    onSuccess: async (next) => {
      setChange(next)
      await invalidateAlbumChange(client, next)
    },
  })
  const editions = album.editions ?? []
  const editionOf = album.editionOf ?? null
  const notices = (
    <>
      {change && (
        <AlbumChangeNotice
          change={change}
          onChange={setChange}
          onDismiss={() => setChange(null)}
        />
      )}
      {separate.isError && (
        <Notice tone="danger">
          {errorMessage(separate.error, 'The edition could not be separated.')}
        </Notice>
      )}
    </>
  )
  const onSeparate = (albumId: string) => {
    setChange(null)
    separate.mutate(albumId)
  }
  if (editionOf)
    return (
      <Section
        title="Edition of"
        aside={
          <Button
            size="xs"
            disabled={separate.isPending}
            aria-label={`Separate ${album.title} from ${editionOf.title}`}
            onClick={() => onSeparate(album.id)}
          >
            Separate
          </Button>
        }
      >
        {notices}
        <EditionsTable label="First album" albums={[editionOf]} />
      </Section>
    )
  if (editions.length)
    return (
      <Section title="Editions" note={formatCount(editions.length)}>
        {notices}
        <EditionsTable
          label={`Editions of ${album.title}`}
          albums={editions}
          separate={{ pending: separate.isPending, onSeparate }}
        />
      </Section>
    )
  return change || separate.isError ? (
    <Section title="Editions">{notices}</Section>
  ) : null
}
