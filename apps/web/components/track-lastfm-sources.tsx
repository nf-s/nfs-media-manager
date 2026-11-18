'use client'

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
import { Button } from '@repo/ui/components/ui/button'
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
} from './secondary-table'
import ServiceIconLinks from './service-icon-links'
import {
  changeTrackScrobbleMatch,
  canMergeLastfmTrack,
  TrackMergePanel,
  type TrackScrobbleCorrection,
} from './track-merge'

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
}: {
  track: TrackDetail
  disabled: boolean
  onPick: (name: TrackScrobbledName) => void
}) {
  const { apiBaseUrl } = useConfig()
  const [draft, setDraft] = useState(track.title.slice(0, 200))
  const query = useDeferredValue(draft.trim())
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
            <Button size="xs" onClick={names.retry}>
              Retry
            </Button>
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
          >
            <TableHeader>
              <TableRow>
                <TableHead>Track</TableHead>
                <TableHead>Artist</TableHead>
                <TableHead>Albums</TableHead>
                <TableHead align="end">Scrobbles</TableHead>
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
    onSuccess: async ({ targetId, sourceRemoved }, { action, name }) => {
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
      await invalidateScrobbleLinks(
        client,
        sourceRemoved ? sourceId : undefined,
      )
    },
  })
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
          {result && (
            <p role="status" className="ds-help">
              {result.message}{' '}
              {result.targetId !== item.id && (
                <DetailLink kind="track" id={result.targetId} tab="sources">
                  Open track
                </DetailLink>
              )}
            </p>
          )}
          {item.lastfmSources.length ? (
            <Table aria-label="Recorded by Last.fm">
              <TableHeader>
                <TableRow>
                  <TableHead>Track</TableHead>
                  <TableHead>Artist</TableHead>
                  <TableHead>Albums</TableHead>
                  <TableHead align="end">Scrobbles</TableHead>
                  <TableHead>
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
        </div>
      </Section>
      {item.listening.sources.length > 0 && (
        <Section
          title="Scrobbled names"
          note={formatCount(item.listening.sources.length)}
        >
          <Table aria-label="Scrobbled names">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Match</TableHead>
                <TableHead align="end">Scrobbles</TableHead>
                <TableHead>
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
