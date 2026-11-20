'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useDeferredValue, useEffect, useId, useRef, useState } from 'react'
import { X } from 'lucide-react'
import {
  SpotifyTrackAuditAssessmentSchema,
  SpotifyTrackAuditPageSchema,
  SpotifyTrackAuditQuerySchema,
  type SpotifyTrackAuditAssessment,
  type SpotifyTrackAuditCandidate,
  type SpotifyTrackAuditItem,
  type SpotifyTrackAuditQuery,
} from '@repo/schemas/spotify-track-search'
import { KeyValues, Section, Stats } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Status } from '@repo/ui/components/ds/status'
import { PageHead, Select } from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import {
  TableCell,
  TableHead,
  TableRow,
  TableState,
} from '@repo/ui/components/ui/table'
import {
  EMPTY_VALUE,
  formatCount,
  formatDate,
  formatDateTime,
  formatItemCount,
  formatTrackLength,
} from '@repo/ui/lib/format'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { fetchApiData } from '@/utils/api'
import { DetailLink } from './detail-link'
import {
  replaceWorkspaceUrl,
  useDetailInspector,
} from './detail-inspector-context'
import { useConfig } from './providers'
import {
  SecondaryCell,
  SecondaryTableHead,
  SecondaryTableScroll,
  SecondaryTableSearch,
  SecondaryTableToolbar,
  SecondaryVirtualRows,
  useTableColumns,
} from './secondary-table'
import ServiceIconLinks from './service-icon-links'
import {
  SpotifySavedCandidateConfirmation,
  useSpotifyTrackSearchAcceptPending,
} from './spotify-track-search'

const metadataHref = '/jobs/metadata?mediaType=track'
const pageSize = 25
const trackNoun = { one: 'track', other: 'tracks' }
const assessmentLabels: Record<SpotifyTrackAuditAssessment, string> = {
  likely: 'Likely match',
  review: 'Needs review',
  unlikely: 'Unlikely match',
}
const auditColumns: ReadonlyArray<{
  key: SpotifyTrackAuditQuery['sort'] | 'spotify'
  required?: boolean
  label: string
  width: number
  fill?: boolean
}> = [
  {
    key: 'title',
    label: 'Library track',
    width: 270,
    fill: true,
    required: true,
  },
  { key: 'spotify', label: 'Best Spotify candidate', width: 300 },
  { key: 'assessment', label: 'Assessment', width: 144 },
  { key: 'candidates', label: 'Candidates', width: 116 },
]

function Assessment({
  value,
  summary,
}: {
  value: SpotifyTrackAuditAssessment
  summary: string
}) {
  return (
    <Status state={value === 'likely' ? 'attention' : 'never'} title={summary}>
      {assessmentLabels[value]}
    </Status>
  )
}

function searchDate(candidate: SpotifyTrackAuditCandidate) {
  return (
    <time
      dateTime={candidate.searchedAt}
      title={formatDateTime(candidate.searchedAt)}
    >
      {candidate.historical ? 'Earlier search' : 'Latest search'} ·{' '}
      {formatDate(candidate.searchedAt)}
    </time>
  )
}

function RecordingDetails({
  title,
  artists,
  albums,
  durations,
}: {
  title: string
  artists: readonly string[]
  albums: readonly string[]
  durations: readonly number[]
}) {
  return (
    <div className="break-words">
      <KeyValues
        items={[
          { label: 'Title', value: title },
          { label: 'Artists', value: artists.join(', ') || EMPTY_VALUE },
          { label: 'Albums', value: albums.join(', ') || EMPTY_VALUE },
          {
            label: 'Duration',
            value:
              durations
                .map((seconds) => formatTrackLength(seconds * 1000))
                .join(', ') || EMPTY_VALUE,
          },
        ]}
      />
    </div>
  )
}

export function SpotifyTrackAuditEvidence({
  track,
  onClose,
  onAccepted,
}: {
  track: SpotifyTrackAuditItem
  onClose: () => void
  onAccepted?: (targetId: string) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const [candidateId, setCandidateId] = useState(
    track.candidates[0]?.spotifyTrackId ?? '',
  )
  const candidate = track.candidates.find(
    (item) => item.spotifyTrackId === candidateId,
  )
  const pending = useSpotifyTrackSearchAcceptPending(track.trackId)
  useEffect(() => {
    const previous = document.activeElement
    const element = dialog.current
    if (!element?.open) element?.showModal()
    close.current?.focus()
    return () => {
      element?.close()
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true })
    }
  }, [])

  return (
    <dialog
      ref={dialog}
      className="sec-drawer"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!pending) onClose()
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (!pending && event.target === event.currentTarget) onClose()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="ds-inspector">
        <div className="ds-inspector-bar">
          <h2 className="ds-crumbs" id={titleId}>
            <b>Review Spotify match</b>
          </h2>
          <Button
            ref={close}
            variant="ghost"
            icon
            aria-label="Close Spotify match audit details"
            disabled={pending}
            onClick={onClose}
          >
            <X className="ds-i" aria-hidden="true" />
          </Button>
        </div>
        <div className="ds-inspector-body">
          <Section title="Comparison" flush>
            {track.candidates.length > 1 && (
              <label className="ds-field">
                <span className="ds-label">Saved Spotify candidates</span>
                <Select
                  className="w-full"
                  value={candidateId}
                  disabled={pending}
                  onChange={(event) => setCandidateId(event.target.value)}
                >
                  {track.candidates.map((item) => (
                    <option
                      key={item.spotifyTrackId}
                      value={item.spotifyTrackId}
                    >
                      {[item.title, item.artists.join(', '), item.albumName]
                        .filter(Boolean)
                        .join(' · ')}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <Section title="Library track" flush>
              <RecordingDetails {...track} />
            </Section>
            {candidate && (
              <Section
                title="Spotify candidate"
                note={searchDate(candidate)}
                aside={
                  <Assessment
                    value={candidate.assessment}
                    summary={candidate.summary}
                  />
                }
              >
                <RecordingDetails
                  title={candidate.title}
                  artists={candidate.artists}
                  albums={candidate.albumName ? [candidate.albumName] : []}
                  durations={[candidate.durationSec]}
                />
              </Section>
            )}
            {candidate && (
              <SpotifySavedCandidateConfirmation
                key={candidate.spotifyTrackId}
                trackId={track.trackId}
                candidateId={candidate.spotifyTrackId}
                canConfirm={
                  !candidate.reasons.some(
                    ({ code }) => code === 'alternate-coverage',
                  )
                }
                onAccepted={onAccepted ?? onClose}
                onOpenConflict={onClose}
              />
            )}
            <div className="ds-actions flex-wrap">
              <Button asChild size="xs">
                <DetailLink
                  kind="track"
                  id={track.trackId}
                  tab="sources"
                  view={{ sourceProvider: 'spotify' }}
                  onClick={(event) => {
                    if (pending) {
                      event.preventDefault()
                      return
                    }
                    if (
                      event.button === 0 &&
                      !event.metaKey &&
                      !event.altKey &&
                      !event.ctrlKey &&
                      !event.shiftKey
                    )
                      onClose()
                  }}
                >
                  Open track Sources
                </DetailLink>
              </Button>
              {candidate && (
                <ServiceIconLinks
                  itemTitle={candidate.title}
                  links={[
                    {
                      provider: 'spotify',
                      label: 'Spotify',
                      url: candidate.spotifyUrl,
                    },
                  ]}
                />
              )}
            </div>
          </Section>
          {candidate && (candidate.summary || candidate.reasons.length > 0) && (
            <Section title="Match evidence">
              {candidate.summary && (
                <p className="break-words">{candidate.summary}</p>
              )}
              {candidate.reasons.map((reason, index) => (
                <Section
                  key={`${reason.code}-${index}`}
                  title={reason.explanation}
                >
                  <div className="break-words">
                    <KeyValues
                      items={[
                        {
                          label: 'Library',
                          value: reason.library || EMPTY_VALUE,
                        },
                        {
                          label: 'Spotify',
                          value: reason.spotify || EMPTY_VALUE,
                        },
                      ]}
                    />
                  </div>
                </Section>
              ))}
            </Section>
          )}
        </div>
      </div>
    </dialog>
  )
}

export async function loadSpotifyTrackAudit(
  apiBaseUrl: string,
  query: SpotifyTrackAuditQuery,
  signal?: AbortSignal,
) {
  const { page, size, sort, direction, q, assessment } = query
  const params = new URLSearchParams({
    page: String(page),
    size: String(size),
    sort,
    direction,
    ...(q ? { q } : {}),
    ...(assessment ? { assessment } : {}),
  })
  return fetchApiData(
    apiBaseUrl,
    `/api/v1/spotify/tracks/match-audit?${params}`,
    SpotifyTrackAuditPageSchema,
    { signal },
  )
}

export default function SpotifyTrackMatchAudit() {
  const { apiBaseUrl } = useConfig()
  const pathname = usePathname()
  const params = useSearchParams()
  const inspector = useDetailInspector()
  const [opened, setOpened] = useState<SpotifyTrackAuditItem | null>(null)
  const [matchedId, setMatchedId] = useState<string | null>(null)
  const urlSearch = (params.get('q') ?? '').slice(0, 200)
  const [search, setSearch] = useState(urlSearch)
  useEffect(() => setSearch(urlSearch), [urlSearch])
  const q = useDeferredValue(search.trim())
  const assessmentParam = SpotifyTrackAuditAssessmentSchema.safeParse(
    params.get('assessment'),
  )
  const assessment = assessmentParam.data
  const sort =
    SpotifyTrackAuditQuerySchema.shape.sort.safeParse(params.get('sort'))
      .data ?? 'assessment'
  const direction = params.get('direction') === 'desc' ? 'desc' : 'asc'

  const rows = useVirtualTable({
    queryKey: ['tracks', 'spotify-match-audit', q, assessment, sort, direction],
    pageSize,
    loadPage: (page, size, signal) =>
      loadSpotifyTrackAudit(
        apiBaseUrl,
        {
          page,
          size,
          q,
          assessment,
          sort,
          direction,
        },
        signal,
      ),
  })
  const report = rows.firstPage
  const columns = useTableColumns('spotify-track-match-audit', auditColumns)
  const shown = auditColumns.filter(({ key }) => columns.visible(key))
  const layout = columns.layout([104, ...shown.map(({ key }) => key)])
  const columnCount = 1 + shown.length
  function updateParams(updates: Record<string, string | undefined>) {
    const next = new URLSearchParams(window.location.search)
    for (const [key, value] of Object.entries(updates)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    replaceWorkspaceUrl(
      next.size ? `${pathname}?${next}` : pathname,
      Boolean(inspector?.active),
    )
  }
  function changeSearch(value: string) {
    setSearch(value)
    updateParams({ q: value.trim() ? value : undefined })
  }

  return (
    <section className="ops-page" aria-label="Spotify match audit">
      <PageHead
        title="Spotify match audit"
        note={
          report?.generatedAt && (
            <time dateTime={report.generatedAt}>
              Updated {formatDateTime(report.generatedAt)}
            </time>
          )
        }
        actions={
          <Button asChild variant="link" size="xs">
            <Link href={metadataHref}>Track metadata</Link>
          </Button>
        }
      />
      <div className="ops-fill">
        {report && (
          <div className="ops-notice">
            <Stats
              items={[
                {
                  label: 'tracks with saved candidates',
                  value: formatCount(report.totalTracks),
                },
                {
                  label: 'Spotify candidates',
                  value: formatCount(report.totalCandidates),
                },
                {
                  label: 'likely matches',
                  value: formatCount(report.counts.likely),
                },
              ]}
            />
          </div>
        )}
        <SecondaryTableToolbar
          search={
            <SecondaryTableSearch
              label="Search Spotify match audit"
              placeholder="Search tracks, artists or albums"
              maxLength={200}
              value={search}
              onChange={changeSearch}
            />
          }
          filters={
            <Select
              aria-label="Assessment"
              value={assessment ?? ''}
              onChange={(event) =>
                updateParams({ assessment: event.target.value })
              }
            >
              <option value="">All assessments</option>
              {SpotifyTrackAuditAssessmentSchema.options.map((value) => (
                <option key={value} value={value}>
                  {assessmentLabels[value]}
                  {report ? ` (${formatCount(report.counts[value])})` : ''}
                </option>
              ))}
            </Select>
          }
          columns={columns.controls}
          count={
            rows.hasTotal
              ? formatItemCount(rows.total, trackNoun)
              : 'Loading tracks…'
          }
        />
        {matchedId && (
          <p role="status" className="ds-muted">
            Spotify match saved.{' '}
            <DetailLink kind="track" id={matchedId} tab="sources">
              Open track
            </DetailLink>
          </p>
        )}
        {rows.isError && (
          <div className="ops-notice">
            <Notice
              tone="danger"
              action={
                <Button size="xs" onClick={rows.retry}>
                  Retry
                </Button>
              }
            >
              Could not load the Spotify match audit.
            </Notice>
          </div>
        )}
        <SecondaryTableScroll
          ref={rows.scroller}
          onScroll={rows.onScroll}
          role="region"
          aria-label="Spotify match audit results"
          aria-busy={rows.isFetching}
        >
          <table
            className="ds-table"
            aria-label="Spotify match audit tracks"
            aria-rowcount={rows.hasTotal ? rows.total + 1 : undefined}
            {...layout.table}
          >
            {layout.colgroup}
            <thead>
              <TableRow>
                <TableHead>Review</TableHead>
                {shown.map(({ key, label }) =>
                  key === 'spotify' ? (
                    <TableHead key={key} resizer={columns.resizer(key)}>
                      {label}
                    </TableHead>
                  ) : (
                    <SecondaryTableHead
                      key={key}
                      label={label}
                      sortKey={key}
                      sortBy={sort}
                      direction={direction}
                      align={key === 'candidates' ? 'end' : undefined}
                      resizer={columns.resizer(key)}
                      onSort={(next) =>
                        updateParams({
                          sort: next === 'assessment' ? undefined : next,
                          direction:
                            sort === next && direction === 'asc'
                              ? 'desc'
                              : undefined,
                        })
                      }
                    />
                  ),
                )}
              </TableRow>
            </thead>
            <tbody>
              {!rows.isError && rows.hasTotal && rows.total === 0 && (
                <TableState colSpan={columnCount}>
                  {q || assessment
                    ? 'No tracks match these filters.'
                    : 'No unmatched tracks with saved Spotify candidates.'}
                </TableState>
              )}
              <SecondaryVirtualRows
                window={rows}
                colSpan={columnCount}
                renderRow={(item, index) => {
                  const bestCandidate = item.candidates[0]
                  return (
                    <TableRow key={item.trackId} aria-rowindex={index + 2}>
                      <TableCell>
                        <Button
                          size="xs"
                          aria-haspopup="dialog"
                          aria-label={`Review match for ${item.title}`}
                          onClick={() => setOpened(item)}
                        >
                          Review match
                        </Button>
                      </TableCell>
                      <TableCell>
                        <SecondaryCell
                          text={[item.title, ...item.artists].join(' · ')}
                        >
                          <Button
                            variant="link"
                            size="xs"
                            aria-haspopup="dialog"
                            onClick={() => setOpened(item)}
                          >
                            {item.title}
                          </Button>
                          {item.artists.length > 0 && (
                            <span className="ds-muted">
                              {' '}
                              · {item.artists.join(', ')}
                            </span>
                          )}
                        </SecondaryCell>
                      </TableCell>
                      {columns.visible('spotify') && (
                        <TableCell>
                          <SecondaryCell>
                            {bestCandidate
                              ? [
                                  bestCandidate.title,
                                  ...bestCandidate.artists,
                                  bestCandidate.albumName,
                                ]
                                  .filter(Boolean)
                                  .join(' · ')
                              : EMPTY_VALUE}
                          </SecondaryCell>
                        </TableCell>
                      )}
                      {columns.visible('assessment') && (
                        <TableCell>
                          <Assessment
                            value={item.assessment}
                            summary={item.summary}
                          />
                        </TableCell>
                      )}
                      {columns.visible('candidates') && (
                        <TableCell align="end">
                          {formatCount(item.candidates.length)}
                        </TableCell>
                      )}
                    </TableRow>
                  )
                }}
              />
            </tbody>
          </table>
        </SecondaryTableScroll>
      </div>
      {opened && (
        <SpotifyTrackAuditEvidence
          key={opened.trackId}
          track={opened}
          onAccepted={(targetId) => {
            setMatchedId(targetId)
            setOpened(null)
          }}
          onClose={() => setOpened(null)}
        />
      )}
    </section>
  )
}
