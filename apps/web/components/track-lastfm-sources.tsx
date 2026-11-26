'use client'

import { ReadButton } from '@/components/read-button'
import { useDeferredValue, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  TrackMergeResultSchema,
  TrackScrobbleNamesPageSchema,
  TrackScrobbleRemoveInputSchema,
  type TrackDetail,
  type TrackScrobbleNameKey,
  type TrackScrobbledName,
} from '@repo/schemas/tracks'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import {
  Button,
  mutationFeedback,
  type ButtonFeedback,
} from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableState,
} from '@repo/ui/components/ui/table'
import { formatCount } from '@repo/ui/lib/format'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { fetchApiData } from '@/utils/api'
import { trackScrobbleRuleLabels } from '@/utils/track-browse'
import { lastfmTrackUrl } from '@/utils/track-links'
import { ConfirmAction } from './confirm-action'
import { DetailLink } from './detail-link'
import { errorMessage, invalidateScrobbleLinks } from './lastfm-sync'
import { useConfig } from './providers'
import {
  SecondaryCell,
  SecondaryTableScroll,
  SecondaryVirtualRows,
  useTableWidths,
} from './secondary-table'
import ServiceIconLinks from './service-icon-links'
import {
  changeTrackScrobbleMatch,
  canMergeLastfmTrack,
  TrackMergePanel,
  type TrackScrobbleCorrection,
} from './track-merge'

const nameSearchColumns = [
  { key: 'track', label: 'Track', width: 140 },
  { key: 'artist', label: 'Artist', width: 120 },
  { key: 'albums', label: 'Albums', width: 130 },
  { key: 'scrobbles', label: 'Scrobbles', width: 80 },
]
/** Room for Link or Linked here. */
const nameSearchActionsWidth = 84
const recordedColumns = [
  { key: 'track', label: 'Track', width: 120 },
  { key: 'artist', label: 'Artist', width: 100 },
  { key: 'albums', label: 'Albums', width: 110 },
  { key: 'scrobbles', label: 'Scrobbles', width: 80 },
  // Room for Change match, Remove and Use automatic match.
  { key: 'actions', label: 'Actions', width: 300 },
]
const listeningColumns = [
  { key: 'name', label: 'Name', width: 180 },
  { key: 'match', label: 'Match', width: 120 },
  { key: 'scrobbles', label: 'Scrobbles', width: 80 },
  // Room for Change match and Keep separate.
  { key: 'actions', label: 'Actions', width: 210 },
]

type NameUpdate =
  | { action: 'link'; name: TrackScrobbledName }
  | { action: 'remove' | 'automatic'; name: TrackScrobbleNameKey }

function nameKey(name: TrackScrobbleNameKey) {
  return JSON.stringify([name.artistKey, name.trackKey])
}

function RecordedTrack({
  artistName,
  trackName,
  label = trackName,
}: {
  artistName: string
  trackName: string
  label?: string
}) {
  const url = lastfmTrackUrl(artistName, trackName)
  return (
    <span className="ds-cell-id">
      <span className="ds-cell-title" title={label}>
        {label}
      </span>
      {url && (
        <ServiceIconLinks
          links={[{ provider: 'lastfm', label: 'Last.fm', url }]}
        />
      )}
    </span>
  )
}

function TrackScrobbledNamePicker({
  track,
  disabled,
  onPick,
  feedback,
}: {
  track: TrackDetail
  disabled: boolean
  onPick: (name: TrackScrobbledName) => void
  feedback: (name: TrackScrobbledName) => ButtonFeedback | undefined
}) {
  const { apiBaseUrl } = useConfig()
  const [draft, setDraft] = useState(track.title.slice(0, 200))
  const query = useDeferredValue(draft.trim())
  const widths = useTableWidths(
    'track-scrobbled-name-search',
    nameSearchColumns,
  )
  const layout = widths.layout([
    ...nameSearchColumns.map((column) => column.key),
    nameSearchActionsWidth,
  ])
  const names = useVirtualTable({
    queryKey: ['tracks', 'scrobbled-names', track.id, query],
    enabled: query.length > 0,
    pageSize: 25,
    loadPage: (page, size, signal) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/tracks/${encodeURIComponent(track.id)}/scrobble-names?${new URLSearchParams({ q: query, page: String(page), size: String(size) })}`,
        TrackScrobbleNamesPageSchema,
        { signal },
      ),
  })
  return (
    <>
      <Input
        type="search"
        aria-label="Search scrobbled names"
        placeholder="Search scrobbled tracks or artists"
        maxLength={200}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      {names.isError && (
        <Notice
          tone="danger"
          action={
            <ReadButton size="xs" read={names.retry}>
              Retry
            </ReadButton>
          }
        >
          Could not search scrobbled names.
        </Notice>
      )}
      {query && (
        <SecondaryTableScroll
          ref={names.scroller}
          onScroll={names.onScroll}
          className="dtl-bounded"
          role="region"
          aria-label="Scrobbled name search results"
          aria-busy={names.isFetching}
        >
          <table
            className="ds-table"
            aria-label="Scrobbled name search results"
            {...layout.table}
          >
            {layout.colgroup}
            <TableHeader>
              <TableRow>
                <TableHead resizer={widths.resizer('track')}>Track</TableHead>
                <TableHead resizer={widths.resizer('artist')}>Artist</TableHead>
                <TableHead resizer={widths.resizer('albums')}>Albums</TableHead>
                <TableHead align="end" resizer={widths.resizer('scrobbles')}>
                  Scrobbles
                </TableHead>
                <TableHead align="end">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {names.hasTotal && !names.total && (
                <TableState colSpan={5}>
                  No matching scrobbled names.
                </TableState>
              )}
              <SecondaryVirtualRows
                window={names}
                colSpan={5}
                renderRow={(name) => {
                  const albums = name.albumNames.join(' · ')
                  const linkedHere = name.trackId === track.id
                  const label = `${name.trackName} by ${name.artistName}`
                  return (
                    <TableRow key={nameKey(name)}>
                      <TableCell>
                        <SecondaryCell text={name.trackName}>
                          {name.trackName}
                        </SecondaryCell>
                      </TableCell>
                      <TableCell>
                        <SecondaryCell text={name.artistName}>
                          {name.artistName}
                        </SecondaryCell>
                      </TableCell>
                      <TableCell>
                        <SecondaryCell text={albums}>
                          {albums || 'Album not supplied'}
                        </SecondaryCell>
                      </TableCell>
                      <TableCell align="end">
                        {formatCount(name.count)}
                      </TableCell>
                      <TableCell align="end">
                        {linkedHere &&
                        name.manuallyMatched &&
                        !name.keptSeparate ? (
                          <span className="ds-muted">Linked here</span>
                        ) : (
                          <ConfirmAction
                            size="xs"
                            disabled={disabled || draft.trim() !== query}
                            ariaLabel={`Link ${label}`}
                            question={`Link ${label} to this track?`}
                            details="Later syncs will keep this recorded name and its listening history linked here."
                            confirmLabel="Link"
                            onConfirm={() => onPick(name)}
                            feedback={feedback(name)}
                          >
                            Link
                          </ConfirmAction>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                }}
              />
            </TableBody>
          </table>
        </SecondaryTableScroll>
      )}
    </>
  )
}

export function TrackLastfmSources({
  item,
  onResolved,
}: {
  item: TrackDetail
  onResolved?: (targetId: string) => void
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [mergeKind, setMergeKind] = useState<'names' | 'spotify' | null>(null)
  const [moving, setMoving] = useState<TrackScrobbleCorrection | null>(null)
  const [result, setResult] = useState<{
    message: string
    targetId: string
  } | null>(null)
  const update = useMutation({
    retry: false,
    mutationFn: ({ action, name }: NameUpdate) => {
      if (action === 'link')
        return changeTrackScrobbleMatch(apiBaseUrl, name.trackId, item.id, name)
      return fetchApiData(
        apiBaseUrl,
        `/api/v1/tracks/${encodeURIComponent(item.id)}/scrobble-match`,
        TrackMergeResultSchema,
        {
          method: 'DELETE',
          body: JSON.stringify(
            TrackScrobbleRemoveInputSchema.parse({
              artistKey: name.artistKey,
              trackKey: name.trackKey,
              ...(action === 'automatic' && { mode: 'automatic' }),
            }),
          ),
        },
      )
    },
    onMutate: () => setResult(null),
    onSuccess: ({ targetId, sourceRemoved }, { action, name }) => {
      if (action === 'link') setAdding(false)
      const sourceId = action === 'link' ? name.trackId : item.id
      if (sourceRemoved && sourceId === item.id && onResolved)
        onResolved(targetId)
      else
        setResult({
          message:
            action === 'link'
              ? 'Scrobbled name linked.'
              : action === 'automatic'
                ? 'Automatic matching restored.'
                : 'Scrobbled name kept separate.',
          targetId,
        })
      void invalidateScrobbleLinks(client, sourceRemoved ? sourceId : undefined)
    },
  })
  function feedback(action: NameUpdate['action'], name: TrackScrobbleNameKey) {
    if (
      update.variables?.action !== action ||
      nameKey(update.variables.name) !== nameKey(name)
    )
      return undefined
    return mutationFeedback(
      update,
      action === 'link'
        ? {
            pending: 'Linking name…',
            success: 'Name linked',
            error: 'Could not link',
          }
        : action === 'automatic'
          ? {
              pending: 'Restoring automatic match…',
              success: 'Automatic matching restored',
              error: 'Could not restore match',
            }
          : {
              pending: 'Keeping name separate…',
              success: 'Kept separate',
              error: 'Could not keep separate',
            },
    )
  }
  const recordedWidths = useTableWidths('track-lastfm-sources', recordedColumns)
  const recordedLayout = recordedWidths.layout(
    recordedColumns.map((column) => column.key),
  )
  const listeningWidths = useTableWidths(
    'track-scrobbled-names',
    listeningColumns,
  )
  const listeningLayout = listeningWidths.layout(
    listeningColumns.map((column) => column.key),
  )
  const strictNames = new Set(item.lastfmSources.map(nameKey))
  const changeMatchButton = (source: TrackScrobbleCorrection) => (
    <Button
      size="xs"
      variant="ghost"
      aria-label={`Change match for ${source.trackName} by ${source.artistName}`}
      aria-haspopup="dialog"
      disabled={update.isPending}
      onClick={() => {
        update.reset()
        setResult(null)
        setMoving(source)
      }}
    >
      Change match
    </Button>
  )
  const removeNameButton = (
    source: TrackScrobbleCorrection,
    listeningOnly = false,
  ) => {
    const label = `${source.trackName} by ${source.artistName}`
    const action = listeningOnly ? 'Keep separate' : 'Remove'
    return (
      <ConfirmAction
        size="xs"
        variant="ghost"
        disabled={update.isPending}
        ariaLabel={`${action} ${label}`}
        feedback={feedback('remove', source)}
        question={
          listeningOnly
            ? `Keep ${label} separate?`
            : `Remove ${label} from this match?`
        }
        details="The recorded name and all its scrobbles will move from any current matches to a separate Last.fm track."
        confirmLabel={action}
        onConfirm={() => update.mutate({ action: 'remove', name: source })}
      >
        {action}
      </ConfirmAction>
    )
  }
  return (
    <>
      <Section
        title="Recorded by Last.fm"
        note={formatCount(item.lastfmSources.length)}
      >
        <div className="data-stack">
          <div className="ds-actions dtl-wrap">
            <Button
              size="xs"
              aria-expanded={adding}
              disabled={update.isPending}
              onClick={() => setAdding(!adding)}
            >
              Add scrobbled name
            </Button>
            {item.lastfmSources.length > 0 && (
              <Button
                size="xs"
                aria-haspopup="dialog"
                disabled={update.isPending}
                onClick={() => setMergeKind('names')}
              >
                Merge Last.fm names
              </Button>
            )}
            {canMergeLastfmTrack(item) && (
              <Button
                size="xs"
                aria-haspopup="dialog"
                disabled={update.isPending}
                onClick={() => setMergeKind('spotify')}
              >
                Merge with Spotify track
              </Button>
            )}
          </div>
          {adding && (
            <TrackScrobbledNamePicker
              track={item}
              disabled={update.isPending}
              onPick={(name) => update.mutate({ action: 'link', name })}
              feedback={(name) => feedback('link', name)}
            />
          )}
          {update.isError && (
            <Notice tone="danger">
              {errorMessage(
                update.error,
                'Could not update the scrobbled name.',
              )}
            </Notice>
          )}
          {item.lastfmSources.length ? (
            <Table aria-label="Recorded by Last.fm" {...recordedLayout.table}>
              {recordedLayout.colgroup}
              <TableHeader>
                <TableRow>
                  <TableHead resizer={recordedWidths.resizer('track')}>
                    Track
                  </TableHead>
                  <TableHead resizer={recordedWidths.resizer('artist')}>
                    Artist
                  </TableHead>
                  <TableHead resizer={recordedWidths.resizer('albums')}>
                    Albums
                  </TableHead>
                  <TableHead
                    align="end"
                    resizer={recordedWidths.resizer('scrobbles')}
                  >
                    Scrobbles
                  </TableHead>
                  <TableHead resizer={recordedWidths.resizer('actions')}>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {item.lastfmSources.map((source) => {
                  const albums = source.albumNames.join(' · ')
                  return (
                    <TableRow
                      key={JSON.stringify([
                        source.artistName,
                        source.trackName,
                      ])}
                    >
                      <TableCell>
                        <RecordedTrack {...source} />
                      </TableCell>
                      <TableCell>{source.artistName}</TableCell>
                      <TableCell>
                        {albums || 'Album not supplied'}
                        {source.keptSeparate ? (
                          <span className="ds-muted"> · Kept separate</span>
                        ) : (
                          source.manuallyMatched && (
                            <span className="ds-muted">
                              {' '}
                              · Manually matched
                            </span>
                          )
                        )}
                      </TableCell>
                      <TableCell align="end">
                        {formatCount(source.count)}
                      </TableCell>
                      <TableCell>
                        <div className="secondary-cell-actions">
                          {changeMatchButton(source)}
                          {!source.keptSeparate && removeNameButton(source)}
                          {(source.keptSeparate || source.manuallyMatched) && (
                            <Button
                              size="xs"
                              variant="ghost"
                              disabled={update.isPending}
                              feedback={feedback('automatic', source)}
                              onClick={() =>
                                update.mutate({
                                  action: 'automatic',
                                  name: source,
                                })
                              }
                            >
                              Use automatic match
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          ) : (
            <p className="ds-help">No linked scrobbled names.</p>
          )}
          {result?.targetId && result.targetId !== item.id && (
            <p role="status" className="ds-help">
              {result.message}{' '}
              <DetailLink kind="track" id={result.targetId} tab="sources">
                Open track
              </DetailLink>
            </p>
          )}
          <span className="sr-only" role="status">
            {result?.targetId === item.id ? result.message : ''}
          </span>
        </div>
      </Section>
      {item.listening.sources.length > 0 && (
        <Section
          title="Scrobbled names"
          note={formatCount(item.listening.sources.length)}
        >
          <Table aria-label="Scrobbled names" {...listeningLayout.table}>
            {listeningLayout.colgroup}
            <TableHeader>
              <TableRow>
                <TableHead resizer={listeningWidths.resizer('name')}>
                  Name
                </TableHead>
                <TableHead resizer={listeningWidths.resizer('match')}>
                  Match
                </TableHead>
                <TableHead
                  align="end"
                  resizer={listeningWidths.resizer('scrobbles')}
                >
                  Scrobbles
                </TableHead>
                <TableHead resizer={listeningWidths.resizer('actions')}>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {item.listening.sources.map((source) => (
                <TableRow
                  key={JSON.stringify([source.artistName, source.trackName])}
                >
                  <TableCell>
                    <RecordedTrack
                      {...source}
                      label={`${source.artistName} — ${source.trackName}`}
                    />
                  </TableCell>
                  <TableCell>
                    {trackScrobbleRuleLabels[source.strategy]}
                  </TableCell>
                  <TableCell align="end">{formatCount(source.count)}</TableCell>
                  <TableCell>
                    {!strictNames.has(nameKey(source)) && (
                      <div className="secondary-cell-actions">
                        {changeMatchButton(source)}
                        {removeNameButton(source, true)}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}
      {moving && (
        <TrackMergePanel
          track={item}
          correction={moving}
          onClose={() => setMoving(null)}
          onMerged={(targetId, sourceRemoved) => {
            if (sourceRemoved && onResolved) onResolved(targetId)
            else setResult({ message: 'Scrobbled name linked.', targetId })
          }}
        />
      )}
      {mergeKind && (
        <TrackMergePanel
          track={item}
          namesOnly={mergeKind === 'names'}
          onClose={() => setMergeKind(null)}
          onMerged={(targetId) => {
            if (onResolved) onResolved(targetId)
            else setResult({ message: 'Last.fm names merged.', targetId })
          }}
        />
      )}
    </>
  )
}
