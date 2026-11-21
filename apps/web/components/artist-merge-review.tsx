'use client'

import type { ArtistMergePlan } from '@repo/schemas/artist-merges'
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
import { formatCount, formatItemCount } from '@repo/ui/lib/format'
import {
  artistMergeBlockLabels,
  describeArtistCreditMoves,
  describeArtistMergeBlock,
  describeArtistMergeCaution,
  describeArtistMergeFollows,
  mergeArtists,
  planArtistMerge,
} from '@/utils/artist-merges'
import { providerLabel } from '@/utils/field-provenance'
import {
  describeLibraryChange,
  invalidateLibraryRecords,
} from '@/utils/library-changes'
import type { MergeAdapter, MergeReviewProps } from './merge-bar'
import {
  SecondaryCell,
  SecondaryTableScroll,
  useTableWidths,
  type TableColumn,
} from './secondary-table'

const reviewColumns: TableColumn[] = [
  { key: 'artist', label: 'Artist', width: 200, fill: true },
  { key: 'albums', label: 'Albums', width: 70 },
  { key: 'tracks', label: 'Tracks', width: 70 },
  { key: 'scrobbles', label: 'Scrobbles', width: 84 },
  { key: 'profiles', label: 'Profiles', width: 130 },
  { key: 'actions', label: '', width: 92, resizable: false },
]

const quoted = (name: string) => `“${name}”`
const credits = { one: 'credit', other: 'credits' }

/** Shown only when something speaks against the merge, or part of it cannot be made. */
function ArtistMergePlanReview({
  plan,
  pending,
  replan,
  follow,
  setFollow,
  error,
}: MergeReviewProps<ArtistMergePlan>) {
  const widths = useTableWidths('artist-merge-review', reviewColumns)
  // An artist can be left out while two others remain to merge.
  const leaving = plan.artists.length > 2
  const layout = widths.layout(
    reviewColumns
      .map((column) => column.key)
      .filter((key) => leaving || key !== 'actions'),
  )
  const artistIds = plan.artists.map((artist) => artist.id)
  const kept = plan.artists.find((artist) => artist.id === plan.targetId)
  const blocked = plan.artists.filter((artist) => artist.blocked)
  const mergeable = plan.artists.filter((artist) => !artist.blocked)
  const { moves } = plan
  const { target, total } = plan.scrobbles
  const added = total - target
  const leaveOut = (id: string) =>
    replan({
      ids: artistIds.filter((artistId) => artistId !== id),
      keepId: plan.targetId,
    })
  return (
    <>
      {plan.cautions.length > 0 && (
        <Notice tone="attention">
          Check before merging.{' '}
          {plan.cautions.map(describeArtistMergeCaution).join(' ')}
        </Notice>
      )}
      {blocked.length > 0 && (
        <Notice
          tone="attention"
          action={
            mergeable.length > 1 ? (
              <Button
                size="xs"
                disabled={pending}
                onClick={() => {
                  const ids = mergeable.map((artist) => artist.id)
                  replan({
                    ids,
                    keepId: ids.includes(plan.targetId)
                      ? plan.targetId
                      : undefined,
                  })
                }}
              >
                Leave {blocked.length === 1 ? 'it' : 'them'} out
              </Button>
            ) : undefined
          }
        >
          {describeArtistMergeBlock(blocked)}
        </Notice>
      )}
      {error}
      <Section title="Result" flush>
        <KeyValues
          items={[
            {
              label: 'Kept',
              value: (
                <Select
                  aria-label="Artist to keep"
                  value={plan.targetId}
                  disabled={pending}
                  onChange={(event) =>
                    replan({ ids: artistIds, keepId: event.target.value })
                  }
                >
                  {plan.artists.map((artist) => (
                    <option key={artist.id} value={artist.id}>
                      {artist.name}
                    </option>
                  ))}
                </Select>
              ),
            },
            {
              label: 'Also known as',
              value: moves.names.length ? (
                moves.names.map(quoted).join(', ')
              ) : (
                <EmptyValue />
              ),
            },
            {
              label: 'Credits moved',
              value: (
                <span className="ds-num">
                  {describeArtistCreditMoves(moves)}
                  {moves.shared > 0 && kept
                    ? ` · ${formatCount(moves.shared)} where ${quoted(kept.name)} is already credited`
                    : ''}
                </span>
              ),
            },
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
      <Section title="Artists">
        <SecondaryTableScroll
          className="dtl-bounded"
          role="region"
          aria-label="Artists to merge"
        >
          <table
            className="ds-table"
            data-rows="two"
            aria-label="Artists to merge"
            {...layout.table}
          >
            {layout.colgroup}
            <TableHeader>
              <TableRow>
                <TableHead resizer={widths.resizer('artist')}>Artist</TableHead>
                <TableHead align="end" resizer={widths.resizer('albums')}>
                  Albums
                </TableHead>
                <TableHead align="end" resizer={widths.resizer('tracks')}>
                  Tracks
                </TableHead>
                <TableHead align="end" resizer={widths.resizer('scrobbles')}>
                  Scrobbles
                </TableHead>
                <TableHead resizer={widths.resizer('profiles')}>
                  Profiles
                </TableHead>
                {leaving && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {plan.artists.map((artist) => {
                const profiles = artist.providers
                  .map((provider) => providerLabel(provider))
                  .join(', ')
                return (
                  <TableRow key={artist.id}>
                    <TableCell>
                      <span className="ds-cell-two">
                        <span className="ds-cell-title" title={artist.name}>
                          {artist.name}
                        </span>
                        <span className="ds-cell-sub">
                          {artist.id === plan.targetId ? (
                            <Status state="done">Kept</Status>
                          ) : artist.blocked ? (
                            <Status state="attention">
                              {artistMergeBlockLabels[artist.blocked]}
                            </Status>
                          ) : (
                            [
                              formatItemCount(artist.creditCount, credits),
                              ...artist.names.map(quoted),
                            ].join(' · ')
                          )}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell align="end">
                      {formatCount(artist.albumCount)}
                    </TableCell>
                    <TableCell align="end">
                      {formatCount(artist.trackCount)}
                    </TableCell>
                    <TableCell align="end">
                      {formatCount(artist.scrobbles)}
                    </TableCell>
                    <TableCell>
                      {profiles ? (
                        <SecondaryCell>{profiles}</SecondaryCell>
                      ) : (
                        <EmptyValue />
                      )}
                    </TableCell>
                    {leaving && (
                      <TableCell align="end">
                        {artist.id !== plan.targetId && (
                          <Button
                            size="xs"
                            variant="ghost"
                            aria-label={`Leave out ${artist.name}`}
                            disabled={pending}
                            onClick={() => leaveOut(artist.id)}
                          >
                            Leave out
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                )
              })}
            </TableBody>
          </table>
        </SecondaryTableScroll>
      </Section>
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
            <span>{describeArtistMergeFollows(plan.also, kept?.name)}</span>
          </label>
        </Section>
      )}
    </>
  )
}

/** Merging artists: the artist merge plan, its review and its wording. */
export const artistMergeAdapter: MergeAdapter<ArtistMergePlan> = {
  plan: (apiBaseUrl, { ids, keepId, follow }) =>
    planArtistMerge(apiBaseUrl, { artistIds: ids, targetId: keepId, follow }),
  merge: (apiBaseUrl, { ids, keepId, follow, reviewed }) =>
    mergeArtists(apiBaseUrl, {
      artistIds: ids,
      targetId: keepId,
      follow,
      reviewed,
    }),
  request: (plan) => ({
    ids: plan.artists.map((artist) => artist.id),
    keepId: plan.targetId,
  }),
  needsReview: (plan) => plan.blocked || plan.cautions.length > 0,
  blocked: (plan) => plan.blocked,
  Review: ArtistMergePlanReview,
  wording: {
    title: (plan) => {
      const mergeable = plan.artists.filter((artist) => !artist.blocked).length
      return mergeable > 1
        ? `Merge ${formatCount(mergeable)} artists`
        : 'Merge artists'
    },
    selectMore: 'Select two or more artists to merge',
    failed: 'The artists could not be merged.',
  },
  describe: describeLibraryChange,
  // Also refreshes the change lists and the Artists browse queries.
  invalidate: (client, change) =>
    invalidateLibraryRecords(
      client,
      'artist',
      change.sources
        .filter((source) => !source.exists)
        .map((source) => source.id),
    ),
}
