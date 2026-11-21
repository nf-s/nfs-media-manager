'use client'

import type { TrackMergePlan } from '@repo/schemas/library-changes'
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
import { formatCount, formatTrackLength } from '@repo/ui/lib/format'
import {
  describeLibraryChange,
  describeMergeCaution,
  mergeBlockLabels,
  mergeTracks,
  planTrackMerge,
} from '@/utils/library-changes'
import { invalidateScrobbleLinks } from './lastfm-sync'
import type { MergeAdapter, MergeReviewProps } from './merge-bar'
import {
  SecondaryCell,
  SecondaryTableScroll,
  useTableWidths,
} from './secondary-table'

const reviewColumns = [
  { key: 'track', label: 'Track', width: 200, fill: true },
  { key: 'album', label: 'Album', width: 130 },
  { key: 'length', label: 'Length', width: 68 },
  { key: 'scrobbles', label: 'Scrobbles', width: 84 },
]

/** Shown only when something speaks against the merge, or part of it cannot be made. */
function TrackMergePlanReview({
  plan,
  pending,
  replan,
  error,
}: MergeReviewProps<TrackMergePlan>) {
  const widths = useTableWidths('track-merge-review', reviewColumns)
  const layout = widths.layout(reviewColumns.map((column) => column.key))
  const trackIds = plan.tracks.map((track) => track.id)
  const kept = plan.tracks.find((track) => track.id === plan.targetId)
  const blocked = plan.tracks.filter((track) => track.blocked)
  const mergeable = plan.tracks.filter((track) => !track.blocked)
  // Any track made only of scrobbled names can be the one that is kept.
  const choosable = plan.tracks.every((track) => track.identity === null)
  const { target, added, total } = plan.scrobbles
  return (
    <>
      {plan.cautions.length > 0 && (
        <Notice tone="attention">
          Check before merging.{' '}
          {plan.cautions.map(describeMergeCaution).join(' ')}
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
                onClick={() =>
                  replan({
                    ids: mergeable.map((track) => track.id),
                    keepId: plan.targetId,
                  })
                }
              >
                Leave {blocked.length === 1 ? 'it' : 'them'} out
              </Button>
            ) : undefined
          }
        >
          {blocked.length === 1
            ? '1 track stays a track of its own.'
            : `${formatCount(blocked.length)} tracks stay tracks of their own.`}{' '}
          Only a track made of scrobbled names can be merged into another.
        </Notice>
      )}
      {error}
      <Section title="Result" flush>
        <KeyValues
          items={[
            {
              label: 'Kept',
              value: choosable ? (
                <Select
                  aria-label="Track to keep"
                  value={plan.targetId}
                  disabled={pending}
                  onChange={(event) =>
                    replan({ ids: trackIds, keepId: event.target.value })
                  }
                >
                  {plan.tracks.map((track) => (
                    <option key={track.id} value={track.id}>
                      {track.title}
                      {track.by ? ` · ${track.by}` : ''}
                    </option>
                  ))}
                </Select>
              ) : (
                <b>{kept?.title}</b>
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
            {
              label: 'Names moved',
              value: (
                <span className="ds-num">{formatCount(plan.names.length)}</span>
              ),
            },
          ]}
        />
      </Section>
      <Section title="Tracks">
        <SecondaryTableScroll
          className="dtl-bounded"
          role="region"
          aria-label="Tracks to merge"
        >
          <table
            className="ds-table"
            aria-label="Tracks to merge"
            {...layout.table}
          >
            {layout.colgroup}
            <TableHeader>
              <TableRow>
                <TableHead resizer={widths.resizer('track')}>Track</TableHead>
                <TableHead resizer={widths.resizer('album')}>Album</TableHead>
                <TableHead align="end" resizer={widths.resizer('length')}>
                  Length
                </TableHead>
                <TableHead align="end" resizer={widths.resizer('scrobbles')}>
                  Scrobbles
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plan.tracks.map((track) => (
                <TableRow key={track.id}>
                  <TableCell>
                    <span className="ds-cell-two">
                      <span className="ds-cell-title" title={track.title}>
                        {track.title}
                      </span>
                      <span className="ds-cell-sub">
                        {track.id === plan.targetId ? (
                          <Status state="done">Kept</Status>
                        ) : track.blocked ? (
                          <Status state="attention">
                            {mergeBlockLabels[track.blocked]}
                          </Status>
                        ) : (
                          track.by || <EmptyValue />
                        )}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>
                    {track.albumTitle ? (
                      <SecondaryCell>{track.albumTitle}</SecondaryCell>
                    ) : (
                      <EmptyValue />
                    )}
                  </TableCell>
                  <TableCell align="end">
                    {track.durationSec ? (
                      formatTrackLength(track.durationSec * 1000)
                    ) : (
                      <EmptyValue />
                    )}
                  </TableCell>
                  <TableCell align="end">
                    {formatCount(track.scrobbles)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </table>
        </SecondaryTableScroll>
      </Section>
    </>
  )
}

/** Merging tracks: the track merge plan, its review and its wording. */
export const trackMergeAdapter: MergeAdapter<TrackMergePlan> = {
  plan: (apiBaseUrl, { ids, keepId }) =>
    planTrackMerge(apiBaseUrl, { trackIds: ids, targetId: keepId }),
  merge: (apiBaseUrl, { ids, keepId, reviewed }) =>
    mergeTracks(apiBaseUrl, { trackIds: ids, targetId: keepId, reviewed }),
  request: (plan) => ({
    ids: plan.tracks.map((track) => track.id),
    keepId: plan.targetId,
  }),
  needsReview: (plan) => plan.blocked || plan.cautions.length > 0,
  blocked: (plan) => plan.blocked,
  Review: TrackMergePlanReview,
  wording: {
    title: (plan) => {
      const mergeable = plan.tracks.filter((track) => !track.blocked).length
      return mergeable > 1
        ? `Merge ${formatCount(mergeable)} tracks`
        : 'Merge tracks'
    },
    selectMore: 'Select two or more tracks to merge',
    failed: 'The tracks could not be merged.',
  },
  describe: describeLibraryChange,
  invalidate: (client, change) =>
    invalidateScrobbleLinks(
      client,
      change.sources
        .filter((source) => !source.exists)
        .map((source) => source.id),
    ),
}
