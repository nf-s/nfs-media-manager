'use client'

import { z } from 'zod'
import {
  TrackMergeBusySchema,
  type TrackMergeOutcome,
  type TrackMergePlan,
} from '@repo/schemas/library-changes'
import { KeyValues, Section } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { EmptyValue } from '@repo/ui/components/ds/pill'
import { Status } from '@repo/ui/components/ds/status'
import { Select } from '@repo/ui/components/ds/toolbar'
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui/components/ui/table'
import {
  formatCount,
  formatItemCount,
  formatTrackLength,
} from '@repo/ui/lib/format'
import {
  describeLibraryChange,
  describeLibraryChangeNote,
  describeMergeCaution,
  mergeTracks,
  planTrackMerge,
} from '@/utils/library-changes'
import { invalidateScrobbleLinks } from './lastfm-sync'
import type { MergeAdapter, MergeRequest, MergeReviewProps } from './merge-bar'
import {
  SecondaryCell,
  SecondaryTableScroll,
  useTableWidths,
} from './secondary-table'

const reviewColumns = [
  { key: 'track', label: 'Track', width: 200, fill: true },
  { key: 'outcome', label: 'Becomes', width: 96 },
  { key: 'album', label: 'Album', width: 130 },
  { key: 'length', label: 'Length', width: 68 },
  { key: 'scrobbles', label: 'Scrobbles', width: 84 },
]

/** What a selected track becomes: the version shown, a version, or merged in. */
const outcomeLabels: Record<TrackMergeOutcome, string> = {
  keep: 'Shown',
  version: 'Version',
  merge: 'Merged',
}

const quoted = (title: string) => `“${title}”`

/**
 * What follows the merge, in sentences: the album names the merged titles
 * were scrobbled under, and the other titles under those album names.
 */
export function describeTrackMergeFollows({
  albumNames,
  titles,
}: TrackMergePlan['also']) {
  const names = titles.length
    ? formatItemCount(titles.length, { one: 'name', other: 'names' })
    : null
  const albums = albumNames.map(
    (name) =>
      `Album name ${quoted(name.albumName)} into ${quoted(name.toAlbumTitle)}`,
  )
  const [album] = albums
  const lines =
    albums.length === 1 && album && names
      ? [`${album}, with ${names} scrobbled under it`]
      : [
          ...albums,
          ...(names
            ? [
                `${names} scrobbled under ${albums.length ? 'them' : 'the same album name'}`,
              ]
            : []),
        ]
  return lines.map((line) => `${line}.`).join(' ')
}

/** Shown only when something speaks against the merge. */
function TrackMergePlanReview({
  plan,
  pending,
  replan,
  follow,
  setFollow,
  error,
}: MergeReviewProps<TrackMergePlan>) {
  const widths = useTableWidths('track-merge-review', reviewColumns)
  const layout = widths.layout(reviewColumns.map((column) => column.key))
  const trackIds = plan.tracks.map((track) => track.id)
  const { target, added, total } = plan.scrobbles
  const follows = plan.also.albumNames.length > 0 || plan.also.titles.length > 0
  return (
    <>
      {plan.cautions.length > 0 && (
        <Notice tone="attention">
          Check before merging.{' '}
          {plan.cautions
            .map((caution) => describeMergeCaution(caution, plan.tracks))
            .join(' ')}
        </Notice>
      )}
      {error}
      <Section title="Result" flush>
        <KeyValues
          items={[
            {
              label: 'Shown as',
              value: (
                <Select
                  aria-label="Shown as"
                  value={plan.targetId}
                  disabled={pending}
                  onChange={(event) =>
                    replan({ ids: trackIds, keepId: event.target.value })
                  }
                >
                  {plan.tracks.map((track) => (
                    <option key={track.id} value={track.id}>
                      {track.title}
                      {track.albumTitle ? ` · ${track.albumTitle}` : ''}
                      {track.by ? ` · ${track.by}` : ''}
                    </option>
                  ))}
                </Select>
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
            data-rows="two"
            aria-label="Tracks to merge"
            {...layout.table}
          >
            {layout.colgroup}
            <TableHeader>
              <TableRow>
                <TableHead resizer={widths.resizer('track')}>Track</TableHead>
                <TableHead resizer={widths.resizer('outcome')}>
                  Becomes
                </TableHead>
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
                        {track.by || <EmptyValue />}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>
                    {track.outcome === 'keep' ? (
                      <Status state="done">{outcomeLabels.keep}</Status>
                    ) : (
                      outcomeLabels[track.outcome]
                    )}
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
      {follows && (
        <Section title="Also merged">
          <label className="ds-checkrow">
            <input
              type="checkbox"
              className="ds-check"
              checked={follow}
              disabled={pending}
              onChange={(event) => setFollow(event.target.checked)}
            />
            <span>{describeTrackMergeFollows(plan.also)}</span>
          </label>
        </Section>
      )}
    </>
  )
}

const InteractiveTrackMergeBusySchema = z.object({
  statusCode: z.literal(503),
  data: TrackMergeBusySchema,
})

function submitTrackMerge(
  apiBaseUrl: string,
  { ids, keepId, reviewed, follow }: MergeRequest & { reviewed: boolean },
  interactive = false,
) {
  return mergeTracks(
    apiBaseUrl,
    {
      trackIds: ids,
      targetId: keepId,
      reviewed,
      follow,
    },
    interactive,
  )
}

/** Merging tracks: the track merge plan, its review and its wording. */
export const trackMergeAdapter: MergeAdapter<TrackMergePlan> = {
  plan: (apiBaseUrl, { ids, keepId }) =>
    planTrackMerge(apiBaseUrl, { trackIds: ids, targetId: keepId }),
  merge: submitTrackMerge,
  request: (plan) => ({
    ids: plan.tracks.map((track) => track.id),
    keepId: plan.targetId,
  }),
  needsReview: (plan) => plan.blocked || plan.cautions.length > 0,
  blocked: (plan) => plan.blocked,
  Review: TrackMergePlanReview,
  wording: {
    title: (plan) =>
      plan.tracks.length > 1
        ? `Merge ${formatCount(plan.tracks.length)} tracks`
        : 'Merge tracks',
    selectMore: 'Select two or more tracks to merge',
    failed: 'The tracks could not be merged.',
  },
  describe: (change) =>
    [describeLibraryChange(change), describeLibraryChangeNote(change)]
      .filter(Boolean)
      .join('. '),
  invalidate: (client, change) =>
    invalidateScrobbleLinks(
      client,
      change.sources
        .filter((source) => !source.exists)
        .map((source) => source.id),
    ),
}

export const interactiveTrackMergeAdapter: MergeAdapter<TrackMergePlan> = {
  ...trackMergeAdapter,
  merge: (apiBaseUrl, request) => submitTrackMerge(apiBaseUrl, request, true),
  canRetry: (failure) =>
    InteractiveTrackMergeBusySchema.safeParse(failure).success,
}
