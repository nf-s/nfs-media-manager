'use client'

import { useDeferredValue, useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, History, X } from 'lucide-react'
import type { LibraryChange } from '@repo/schemas/library-changes'
import type { TrackDetail, TrackListItem } from '@repo/schemas/tracks'
import type {
  TrackPartName,
  TrackPartType,
  TrackPartVersion,
} from '@repo/schemas/track-versions'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { EmptyValue, ProviderMark } from '@repo/ui/components/ds/pill'
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
import { providerLogoUrl } from '@/utils/provider-logos'
import { trackServiceLinks } from '@/utils/track-links'
import {
  changeTrackVersion,
  describeTrackParts,
  loadTrackParts,
  trackPartAlbum,
  trackPartsKey,
  type TrackVersionAction,
} from '@/utils/track-versions'
import { DetailLink } from './detail-link'
import { errorMessage, invalidateScrobbleLinks } from './lastfm-sync'
import { LibraryChangeUndo, useMerge } from './merge-bar'
import { useConfig } from './providers'
import {
  SecondaryCell,
  SecondaryTableScroll,
  SecondaryVirtualRows,
  useTableWidths,
  type TableColumn,
} from './secondary-table'
import ServiceIconLinks from './service-icon-links'
import { loadTrackMergeCandidates } from './track-merge'
import { trackMergeAdapter } from './track-merge-review'

const partColumns: TableColumn[] = [
  { key: 'part', label: 'Part', width: 200, fill: true },
  { key: 'type', label: 'Type', width: 120 },
  { key: 'album', label: 'Album', width: 150 },
  { key: 'scrobbles', label: 'Scrobbles', width: 84 },
  // Room for the radio, and for Separate.
  { key: 'shown', label: 'Shown', width: 64, resizable: false },
  { key: 'actions', label: 'Actions', width: 100, resizable: false },
]

const candidateColumns = [
  { key: 'track', label: 'Track', width: 190, fill: true },
  { key: 'artist', label: 'Artist', width: 130 },
  { key: 'album', label: 'Album', width: 130 },
  { key: 'scrobbles', label: 'Scrobbles', width: 84 },
]
/** Room for Choose. */
const candidateActionWidth = 84
const CANDIDATES = 20

export const trackPartTypeLabels: Record<TrackPartType, string> = {
  spotify: 'Spotify version',
  album: 'Album version',
  lastfm: 'Last.fm version',
}

/** The provider whose mark a part carries. */
const partProviders: Record<TrackPartType, string> = {
  spotify: 'spotify',
  album: 'spotify',
  lastfm: 'lastfm',
}

function PartMark({ provider }: { provider: string }) {
  return <ProviderMark name={provider} src={providerLogoUrl(provider)} hidden />
}

/** Searches the library for the track to merge this one with. */
function TrackMergeWithDialog({
  track,
  excluded,
  onPick,
  onClose,
}: {
  track: TrackListItem
  /** Tracks already in the record. */
  excluded: ReadonlySet<string>
  onPick: (picked: TrackListItem) => void
  onClose: () => void
}) {
  const { apiBaseUrl } = useConfig()
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [draft, setDraft] = useState(track.title.slice(0, 200))
  const query = useDeferredValue(draft.trim())
  const widths = useTableWidths('track-merge-with', candidateColumns)
  const layout = widths.layout([
    ...candidateColumns.map((column) => column.key),
    candidateActionWidth,
  ])
  const candidates = useVirtualTable({
    queryKey: ['tracks', 'scrobble-match-candidates', query],
    pageSize: CANDIDATES,
    enabled: query.length > 0,
    loadPage: (page, _size, signal) =>
      loadTrackMergeCandidates(apiBaseUrl, query, page, signal, true),
  })
  useEffect(() => {
    const element = dialog.current
    const previous = document.activeElement
    if (!element?.open) element?.showModal()
    element?.querySelector('input')?.focus()
    return () => {
      element?.close()
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true })
    }
  }, [])
  return (
    <dialog
      ref={dialog}
      className="dtl-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (event.target === event.currentTarget) onClose()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="dtl-dialog-inner">
        <div className="ds-inspector-bar">
          <div className="ds-crumbs">
            <b id={titleId}>Merge “{track.title}” with…</b>
          </div>
          <Button variant="ghost" icon aria-label="Close" onClick={onClose}>
            <X className="ds-i" aria-hidden="true" />
          </Button>
        </div>
        <div className="dtl-dialog-body">
          <Input
            type="search"
            aria-label="Search tracks"
            placeholder="Search tracks"
            maxLength={200}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          {candidates.isError && (
            <Notice
              tone="danger"
              action={
                <Button size="xs" onClick={candidates.retry}>
                  Retry
                </Button>
              }
            >
              Could not search tracks.
            </Notice>
          )}
          {query.length > 0 && (
            <SecondaryTableScroll
              ref={candidates.scroller}
              onScroll={candidates.onScroll}
              className="dtl-bounded"
              role="region"
              aria-label="Tracks to merge with"
              aria-busy={candidates.isFetching}
            >
              <table
                className="ds-table"
                aria-label="Tracks to merge with"
                {...layout.table}
              >
                {layout.colgroup}
                <TableHeader>
                  <TableRow>
                    <TableHead resizer={widths.resizer('track')}>
                      Track
                    </TableHead>
                    <TableHead resizer={widths.resizer('artist')}>
                      Artist
                    </TableHead>
                    <TableHead resizer={widths.resizer('album')}>
                      Album
                    </TableHead>
                    <TableHead
                      align="end"
                      resizer={widths.resizer('scrobbles')}
                    >
                      Scrobbles
                    </TableHead>
                    <TableHead>
                      <span className="sr-only">Action</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {candidates.hasTotal && !candidates.total && (
                    <TableState colSpan={5}>
                      No library tracks found.
                    </TableState>
                  )}
                  {(!candidates.isError || candidates.hasTotal) && (
                    <SecondaryVirtualRows
                      window={candidates}
                      colSpan={5}
                      renderRow={(item) =>
                        item.id === track.id || excluded.has(item.id) ? (
                          <tr aria-hidden="true" key={item.id}>
                            <td
                              colSpan={5}
                              style={{
                                height: candidates.rowHeight,
                                border: 0,
                                padding: 0,
                              }}
                            />
                          </tr>
                        ) : (
                          <TableRow key={item.id}>
                            <TableCell>
                              <div className="ds-cell-id">
                                <SecondaryCell text={item.title}>
                                  {item.title}
                                </SecondaryCell>
                                <ServiceIconLinks
                                  links={trackServiceLinks(item)}
                                />
                              </div>
                            </TableCell>
                            <TableCell>
                              <SecondaryCell text={item.artists.join(', ')}>
                                {item.artists.join(', ') || <EmptyValue />}
                              </SecondaryCell>
                            </TableCell>
                            <TableCell>
                              <SecondaryCell text={item.albumName ?? undefined}>
                                {item.albumName ?? <EmptyValue />}
                              </SecondaryCell>
                            </TableCell>
                            <TableCell align="end">
                              {formatCount(item.scrobbles)}
                            </TableCell>
                            <TableCell align="end">
                              <Button
                                size="xs"
                                aria-label={`Choose ${item.title} by ${item.artists.join(', ')}`}
                                onClick={() => onPick(item)}
                              >
                                Choose
                              </Button>
                            </TableCell>
                          </TableRow>
                        )
                      }
                    />
                  )}
                </TableBody>
              </table>
            </SecondaryTableScroll>
          )}
        </div>
      </div>
    </dialog>
  )
}

/** One version of the record, with Shown and Separate. */
function VersionRow({
  version,
  current,
  radioName,
  canChange,
  pending,
  onChange,
}: {
  version: TrackPartVersion
  /** The track whose details are open. */
  current: string
  radioName: string
  /** The record has another version to show or separate from. */
  canChange: boolean
  pending: boolean
  onChange: (action: TrackVersionAction, trackId: string) => void
}) {
  const album = trackPartAlbum(version)
  const label = album ? `${version.title} · ${album}` : version.title
  return (
    <TableRow>
      <TableCell>
        <span className="ds-cell-id">
          <PartMark provider={partProviders[version.type]} />
          {version.id === current ? (
            <span className="ds-cell-title" title={version.title}>
              {version.title}
            </span>
          ) : (
            <DetailLink
              className="ds-cell-title"
              kind="track"
              id={version.id}
              tab="sources"
            >
              {version.title}
            </DetailLink>
          )}
        </span>
      </TableCell>
      <TableCell>{trackPartTypeLabels[version.type]}</TableCell>
      <TableCell>
        {album ? (
          <SecondaryCell text={album}>{album}</SecondaryCell>
        ) : (
          <EmptyValue />
        )}
      </TableCell>
      <TableCell align="end">{formatCount(version.scrobbles)}</TableCell>
      <TableCell>
        <input
          type="radio"
          className="ds-check"
          name={radioName}
          aria-label={`Show as ${label}`}
          checked={version.shown}
          disabled={pending || !canChange}
          onChange={() => onChange('shown', version.id)}
        />
      </TableCell>
      <TableCell align="end">
        {canChange && (
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Separate ${label}`}
            disabled={pending}
            onClick={() => onChange('separate', version.id)}
          >
            Separate
          </Button>
        )}
      </TableCell>
    </TableRow>
  )
}

/** A scrobbled name of the record, on the version that owns it. */
function NameRow({
  name,
  owner,
}: {
  name: TrackPartName
  owner: TrackPartVersion | undefined
}) {
  const album = owner ? trackPartAlbum(owner) : null
  return (
    <TableRow>
      <TableCell>
        <span className="ds-cell-id">
          <PartMark provider="lastfm" />
          <span
            className="ds-truncate"
            title={`${name.artistName} — ${name.trackName}`}
          >
            {name.artistName} — {name.trackName}
          </span>
        </span>
      </TableCell>
      <TableCell>
        Scrobbled name
        {name.manuallyMatched && (
          <span className="ds-muted"> · Manually matched</span>
        )}
      </TableCell>
      <TableCell>
        {album ? (
          <SecondaryCell text={album}>{album}</SecondaryCell>
        ) : (
          <EmptyValue />
        )}
      </TableCell>
      <TableCell align="end">{formatCount(name.scrobbles)}</TableCell>
      <TableCell />
      <TableCell />
    </TableRow>
  )
}

/**
 * What the track's record is made of: its versions, with the one its row is
 * shown as and Separate, then the scrobbled names each version owns. Merge
 * with… merges the record with another track. Each change can be undone.
 */
export function TrackRecordParts({
  item,
  onResolved,
}: {
  item: TrackDetail
  /** Opens the track kept by a merge that removed this one. */
  onResolved?: (targetId: string) => void
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const radioName = useId()
  const [picking, setPicking] = useState(false)
  const [change, setChange] = useState<LibraryChange | null>(null)
  const [undoError, setUndoError] = useState<string | null>(null)
  const parts = useQuery({
    queryKey: trackPartsKey(item.id),
    queryFn: ({ signal }) => loadTrackParts(apiBaseUrl, item.id, signal),
  })
  const version = useMutation({
    retry: false,
    mutationFn: ({
      action,
      trackId,
    }: {
      action: TrackVersionAction
      trackId: string
    }) => changeTrackVersion(apiBaseUrl, action, trackId),
    onMutate: () => {
      setChange(null)
      setUndoError(null)
    },
    onSuccess: async (next) => {
      setChange(next)
      await invalidateScrobbleLinks(client)
    },
  })
  const merge = useMerge(trackMergeAdapter, {
    onMerge: (next) => {
      setUndoError(null)
      setChange(next)
      if (
        next.target &&
        next.target.id !== item.id &&
        next.sources.some((source) => source.id === item.id && !source.exists)
      )
        onResolved?.(next.target.id)
    },
  })
  const pending = version.isPending || merge.pending
  const error = version.isError
    ? errorMessage(version.error, 'The version could not be changed.')
    : !merge.review
      ? merge.error
      : null

  if (parts.isPending) return null
  if (parts.isError)
    return (
      <Section title="Made of">
        <Notice
          tone="danger"
          action={
            <Button size="xs" onClick={() => parts.refetch()}>
              Retry
            </Button>
          }
        >
          Could not load what this track is made of.
        </Notice>
      </Section>
    )
  const { versions, names } = parts.data
  const ordered = [
    ...versions.filter((part) => part.shown),
    ...versions.filter((part) => !part.shown),
  ]
  const canChange = versions.length > 1
  return (
    <Section
      title="Made of"
      note={describeTrackParts(parts.data)}
      aside={
        <Button
          size="xs"
          aria-haspopup="dialog"
          disabled={pending}
          onClick={() => {
            merge.clearError()
            setPicking(true)
          }}
        >
          {merge.merging ? 'Merging...' : 'Merge with…'}
        </Button>
      }
    >
      <div className="data-stack">
        {change && (
          <Notice
            icon={
              change.undoneAt ? (
                <History className="ds-i" data-size="sm" aria-hidden="true" />
              ) : (
                <Check className="ds-i" data-size="sm" aria-hidden="true" />
              )
            }
            action={
              <LibraryChangeUndo
                change={change}
                size="xs"
                onChanged={(next) => {
                  setUndoError(null)
                  setChange(next)
                }}
                onError={setUndoError}
              />
            }
          >
            {change.undoneAt ? 'Undone: ' : ''}
            {trackMergeAdapter.describe(change)}
            {undoError ? ` · ${undoError}` : ''}
          </Notice>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        <PartsTable
          current={item.id}
          versions={ordered}
          names={names}
          radioName={radioName}
          canChange={canChange}
          pending={pending}
          onChange={(action, trackId) => version.mutate({ action, trackId })}
        />
      </div>
      {picking && (
        <TrackMergeWithDialog
          track={item}
          excluded={new Set(versions.map((part) => part.id))}
          onClose={() => setPicking(false)}
          onPick={(picked) => {
            setPicking(false)
            setChange(null)
            version.reset()
            void merge.merge([item.id, picked.id])
          }}
        />
      )}
      {merge.dialog}
    </Section>
  )
}

function PartsTable({
  current,
  versions,
  names,
  radioName,
  canChange,
  pending,
  onChange,
}: {
  current: string
  versions: readonly TrackPartVersion[]
  names: readonly TrackPartName[]
  radioName: string
  canChange: boolean
  pending: boolean
  onChange: (action: TrackVersionAction, trackId: string) => void
}) {
  const widths = useTableWidths('track-record-parts', partColumns)
  const layout = widths.layout(partColumns.map((column) => column.key))
  return (
    <Table aria-label="Made of" {...layout.table}>
      {layout.colgroup}
      <TableHeader>
        <TableRow>
          <TableHead resizer={widths.resizer('part')}>Part</TableHead>
          <TableHead resizer={widths.resizer('type')}>Type</TableHead>
          <TableHead resizer={widths.resizer('album')}>Album</TableHead>
          <TableHead align="end" resizer={widths.resizer('scrobbles')}>
            Scrobbles
          </TableHead>
          <TableHead>Shown</TableHead>
          <TableHead>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {versions.map((part) => (
          <VersionRow
            key={part.id}
            version={part}
            current={current}
            radioName={radioName}
            canChange={canChange}
            pending={pending}
            onChange={onChange}
          />
        ))}
        {names.map((name) => (
          <NameRow
            key={JSON.stringify([name.trackId, name.artistKey, name.trackKey])}
            name={name}
            owner={versions.find((part) => part.id === name.trackId)}
          />
        ))}
      </TableBody>
    </Table>
  )
}
