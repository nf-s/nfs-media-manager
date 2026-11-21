'use client'

import { useState } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { Check, History, X } from 'lucide-react'
import type { AlbumMergePlan } from '@repo/schemas/album-merges'
import type { LibraryChange } from '@repo/schemas/library-changes'
import { KeyValues, Section } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { EmptyValue } from '@repo/ui/components/ds/pill'
import { Status } from '@repo/ui/components/ds/status'
import { Select } from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui/components/ui/table'
import { formatCount } from '@repo/ui/lib/format'
import {
  albumMergeBlockLabels,
  albumNameKey,
  describeAlbumMergeCaution,
  describeAlbumMergeFollows,
  describeAlbumMergeUnmatched,
  mergeAlbums,
  moveAlbumName,
  parseAlbumNameKey,
  planAlbumMerge,
  planAlbumNameMove,
  quotedTitles,
} from '@/utils/album-merges'
import {
  describeLibraryChange,
  invalidateLibraryRecords,
} from '@/utils/library-changes'
import {
  LibraryChangeUndo,
  type MergeAdapter,
  type MergeRequest,
  type MergeReviewProps,
} from './merge-bar'
import { SecondaryTableScroll, useTableWidths } from './secondary-table'

const reviewColumns = [
  { key: 'album', label: 'Album', width: 200, fill: true },
  { key: 'released', label: 'Released', width: 96 },
  { key: 'tracks', label: 'Tracks', width: 64 },
  { key: 'scrobbles', label: 'Scrobbles', width: 84 },
]

const year = (date: string | null) => date?.slice(0, 4)

/**
 * The albums an album merge plan merges and the one it keeps. The album to
 * keep is always one of them, as the server requires.
 */
function albumMergeRequest(plan: AlbumMergePlan): MergeRequest {
  const selected = plan.albums
    .filter((album) => album.selected)
    .map((album) => album.id)
  return {
    ids: [...new Set([plan.targetId, ...selected])],
    keepId: plan.targetId,
  }
}

/** What the merge keeps, what becomes editions, and the track names that follow. */
function AlbumMergePlanReview({
  plan,
  pending,
  replan,
  follow,
  setFollow,
  error,
}: MergeReviewProps<AlbumMergePlan>) {
  const widths = useTableWidths('album-merge-review', reviewColumns)
  const layout = widths.layout(reviewColumns.map((column) => column.key))
  const kept = plan.albums.find((album) => album.id === plan.targetId)
  const { ids } = albumMergeRequest(plan)
  const choices = plan.albums.filter((album) => ids.includes(album.id))
  const { target, added, total } = plan.scrobbles
  const albumNames = plan.names.map((name) => name.albumName)
  return (
    <>
      {plan.blocked && (
        <Notice tone="attention">{albumMergeBlockLabels[plan.blocked]}</Notice>
      )}
      {plan.cautions.length > 0 && (
        <Notice tone="attention">
          Check before merging.{' '}
          {plan.cautions
            .map((caution) => describeAlbumMergeCaution(caution, plan))
            .join(' ')}
        </Notice>
      )}
      {error}
      <Section title="Result" flush>
        <KeyValues
          items={[
            {
              label: 'Kept',
              value:
                choices.length > 1 ? (
                  <Select
                    aria-label="Album to keep"
                    value={plan.targetId}
                    disabled={pending}
                    onChange={(event) =>
                      replan({ ids, keepId: event.target.value })
                    }
                  >
                    {choices.map((album) => (
                      <option key={album.id} value={album.id}>
                        {album.title}
                        {album.by ? ` · ${album.by}` : ''}
                        {album.releaseDate
                          ? ` (${year(album.releaseDate)})`
                          : ''}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <b>{kept?.title}</b>
                ),
            },
            ...(plan.editions.length
              ? [
                  {
                    label: 'Editions',
                    value: (
                      <span className="ds-num">
                        {formatCount(plan.editions.length)}
                      </span>
                    ),
                  },
                ]
              : []),
            ...(albumNames.length
              ? [{ label: 'Album names', value: quotedTitles(albumNames) }]
              : []),
            {
              label: 'Scrobbles',
              value: added ? (
                <span className="ds-num">
                  {formatCount(target)} + {formatCount(added)} ={' '}
                  <b>{formatCount(total)}</b>
                </span>
              ) : (
                <span className="ds-num">
                  <b>{formatCount(total)}</b> · none added
                </span>
              ),
            },
          ]}
        />
      </Section>
      {plan.albums.length > 1 && (
        <Section title="Albums">
          <SecondaryTableScroll
            className="dtl-bounded"
            role="region"
            aria-label="Albums to merge"
          >
            <table
              className="ds-table"
              data-rows="two"
              aria-label="Albums to merge"
              {...layout.table}
            >
              {layout.colgroup}
              <TableHeader>
                <TableRow>
                  <TableHead resizer={widths.resizer('album')}>Album</TableHead>
                  <TableHead resizer={widths.resizer('released')}>
                    Released
                  </TableHead>
                  <TableHead align="end" resizer={widths.resizer('tracks')}>
                    Tracks
                  </TableHead>
                  <TableHead align="end" resizer={widths.resizer('scrobbles')}>
                    Scrobbles
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plan.albums.map((album) => (
                  <TableRow key={album.id}>
                    <TableCell>
                      <span className="ds-cell-two">
                        <span className="ds-cell-title" title={album.title}>
                          {album.title}
                        </span>
                        <span className="ds-cell-sub">
                          {album.id === plan.targetId ? (
                            <Status state="done">Kept</Status>
                          ) : (
                            `Edition${album.by ? ` · ${album.by}` : ''}`
                          )}
                        </span>
                      </span>
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
                    <TableCell align="end">
                      {formatCount(album.trackCount)}
                    </TableCell>
                    <TableCell align="end">
                      {formatCount(album.scrobbles)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </table>
          </SecondaryTableScroll>
        </Section>
      )}
      {plan.also.length > 0 && (
        <Section title="Also merged">
          <label className="ds-checkrow">
            <input
              type="checkbox"
              className="ds-check"
              checked={follow}
              disabled={pending}
              onChange={(event) => setFollow(event.target.checked)}
            />
            <span>{describeAlbumMergeFollows(plan)}</span>
          </label>
        </Section>
      )}
      {plan.unmatched.length > 0 && (
        <p className="ds-help">{describeAlbumMergeUnmatched(plan)}</p>
      )}
    </>
  )
}

/**
 * What an album change outside a selection bar did, with Undo or Redo and
 * Dismiss. `onChange` receives the change once it is undone or redone.
 */
export function AlbumChangeNotice({
  change,
  onChange,
  onDismiss,
}: {
  change: LibraryChange
  onChange: (change: LibraryChange) => void
  onDismiss: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  return (
    <Notice
      icon={
        change.undoneAt ? (
          <History className="ds-i" data-size="sm" aria-hidden="true" />
        ) : (
          <Check className="ds-i" data-size="sm" aria-hidden="true" />
        )
      }
      action={
        <span className="ds-actions">
          <LibraryChangeUndo
            change={change}
            size="xs"
            onChanged={(next) => {
              setError(null)
              onChange(next)
            }}
            onError={setError}
          />
          <Button
            size="xs"
            variant="ghost"
            icon
            aria-label="Dismiss"
            onClick={onDismiss}
          >
            <X className="ds-i" aria-hidden="true" />
          </Button>
        </span>
      }
    >
      {change.undoneAt ? 'Undone: ' : ''}
      {describeLibraryChange(change)}
      {error ? ` · ${error}` : ''}
    </Notice>
  )
}

/** Refreshes the albums, tracks and change lists an album change affects. */
export function invalidateAlbumChange(
  client: QueryClient,
  change: LibraryChange,
) {
  return invalidateLibraryRecords(
    client,
    'album',
    [...change.sources, ...(change.target ? [change.target] : [])]
      .filter((record) => !record.exists)
      .map((record) => record.id),
  )
}

const needsReview = (plan: AlbumMergePlan) =>
  plan.blocked !== null || plan.cautions.length > 0

/** Merging albums: the others become editions of the album to keep. */
export const albumMergeAdapter: MergeAdapter<AlbumMergePlan> = {
  plan: (apiBaseUrl, { ids, keepId, follow }) =>
    planAlbumMerge(apiBaseUrl, { albumIds: ids, targetId: keepId, follow }),
  merge: (apiBaseUrl, { ids, keepId, follow, reviewed }) =>
    mergeAlbums(apiBaseUrl, {
      albumIds: ids,
      targetId: keepId,
      follow,
      reviewed,
    }),
  request: albumMergeRequest,
  needsReview,
  blocked: (plan) => plan.blocked !== null,
  Review: AlbumMergePlanReview,
  wording: {
    title: (plan) => {
      const selected = plan.albums.filter((album) => album.selected).length
      return selected > 1
        ? `Merge ${formatCount(selected)} albums`
        : 'Merge albums'
    },
    selectMore: 'Select two or more albums to merge',
    failed: 'The albums could not be merged.',
  },
  describe: describeLibraryChange,
  invalidate: invalidateAlbumChange,
}

/** The album name and album of a name move, from its merge request. */
function albumNameMove({ ids, keepId }: MergeRequest) {
  const [key] = ids
  const name = key === undefined ? null : parseAlbumNameKey(key)
  if (!name || !keepId || ids.length !== 1)
    throw new Error('Choose one album name and the album it moves to.')
  return { ...name, albumId: keepId }
}

/**
 * Merging a scrobbled album name into an album: `ids` is the name's
 * `albumNameKey` and `keepId` the album. The track names scrobbled under it
 * follow onto the album's matching tracks unless the owner turns that off.
 */
export const albumNameMoveAdapter: MergeAdapter<AlbumMergePlan> = {
  plan: async (apiBaseUrl, request) =>
    planAlbumNameMove(apiBaseUrl, {
      ...albumNameMove(request),
      follow: request.follow,
    }),
  merge: async (apiBaseUrl, request) =>
    moveAlbumName(apiBaseUrl, {
      ...albumNameMove(request),
      follow: request.follow,
      reviewed: request.reviewed,
    }),
  request: (plan) => ({
    ids: plan.names.map(albumNameKey),
    keepId: plan.targetId,
  }),
  // The review shows the track names that would follow, so the owner can keep them.
  needsReview: (plan) => needsReview(plan) || plan.also.length > 0,
  blocked: (plan) => plan.blocked !== null,
  Review: AlbumMergePlanReview,
  wording: {
    title: (plan) => {
      const [name] = plan.names
      const kept = plan.albums.find((album) => album.id === plan.targetId)
      return name && kept
        ? `Merge “${name.albumName}” into “${kept.title}”`
        : 'Merge album name'
    },
    selectMore: 'Choose an album name to merge',
    failed: 'The album name could not be merged.',
  },
  describe: describeLibraryChange,
  invalidate: async (client, change) => {
    await invalidateAlbumChange(client, change)
    // The sync status counts the scrobbles linked to the library.
    await client.invalidateQueries({ queryKey: ['lastfm-sync'] })
  },
}
