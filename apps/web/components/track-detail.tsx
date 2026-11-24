'use client'

import { useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { useDetailPerformance } from '@/hooks/useDetailPerformance'
import { useQuery } from '@tanstack/react-query'
import { musicDisplayTags } from '@repo/schemas/music-tags'
import {
  formatBrowseFilterValue,
  formatBrowseValue,
  sameBrowseFilter,
  trackBrowseFields,
  type BrowseFilter,
} from '@repo/schemas/browse'
import {
  TrackDetailSchema,
  trackSourceLabels,
  trackSpotifyMatchLabels,
  type TrackDetail,
  type TrackFact,
} from '@repo/schemas/tracks'
import { formatMusicalKey, type KeyNotation } from '@repo/schemas/musical-keys'
import { formatTagName } from '@repo/schemas/tags'
import { DetailActionsSpacer } from '@repo/ui/components/ds/detail-header'
import { Facts, Section } from '@repo/ui/components/ds/facts'
import { Pill, PillLabel } from '@repo/ui/components/ds/pill'
import { Button } from '@repo/ui/components/ui/button'
import { TabsContent } from '@repo/ui/components/ui/tabs'
import {
  EMPTY_VALUE,
  formatCount,
  formatDate,
  formatTrackLength,
} from '@repo/ui/lib/format'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { providerLabel } from '@/utils/field-provenance'
import { trackServiceLinks } from '@/utils/track-links'
import { useKeyNotation } from '@/utils/key-notation'
import {
  parseTrackFilters,
  trackFilter,
  tracksHref,
} from '@/utils/track-browse'
import { workspaceTabLinkProps } from '@/utils/workspace-tab-destination'
import type { BrowseFilterHref } from '@/utils/browse-items'
import { CreatorDetailState } from './creator-detail-state'

import { DetailTabs, FilterPill, useDetailTab } from './detail-frame'
import { TrackDetailHeader } from './track-detail-header'
import { ListeningStats } from './listening-stats'
import { ListeningTrend } from './listening-trend'
import { canMergeLastfmTrack, TrackMergePanel } from './track-merge'
import { TrackDuplicateNotice } from './track-duplicate-group'
import { DetailMore } from './detail-more'
import { LibraryRecordChanges } from './library-changes'
import {
  TrackAlbumNotices,
  TrackAlbumReferenceLink,
  useTrackAlbumAddition,
} from './track-album-notices'
import { TrackLastfmSources } from './track-lastfm-sources'
import { CatalogLibraryAction } from './catalog-detail'
import { TrackRecordParts } from './track-record-parts'
import MetadataSourceControl from './metadata-source-control'
import { BrowseFilterPill } from './browse-controls'
import { TrackTagEditor, useTrackTagEdits } from './track-tag-editor'
import { TrackSpotifySource } from './track-spotify-source'
import { TrackSpotifyMatchAction } from './track-spotify-match-action'
import { TrackTidalSource } from './tidal-track-match'
import { TrackSonovaultSource } from './sonovault-track-lookup'
import TrackAppearances from './track-appearances'
import { SimilarItems } from './similar-items'

type OnFilter = (filter: BrowseFilter, keepOpen?: boolean) => void
type TrackTab = 'overview' | 'similar' | 'sources'
const trackTabs: readonly [TrackTab, ...TrackTab[]] = [
  'overview',
  'similar',
  'sources',
]
/** Playlists and Listening were tabs before they joined the Overview. */
const trackTabAliases = {
  playlists: 'overview',
  listening: 'overview',
  history: 'sources',
} satisfies Record<string, TrackTab>

function albumShortcut(name: string, filterHref: BrowseFilterHref) {
  return {
    ...workspaceTabLinkProps(filterHref({ field: 'album', value: name }), name),
    tabIndex: 0,
  }
}

/** Values that filter Tracks: in place inside a browser, otherwise as a link. */
function FilterValues({
  field,
  values,
  onFilter,
  filterHref,
  sourcesFor,
}: {
  field: string
  values: readonly string[]
  onFilter?: OnFilter
  filterHref: BrowseFilterHref
  /** The track whose tag sources are shown. */
  sourcesFor?: string
}) {
  const params = useSearchParams()
  const active = parseTrackFilters(params.get('filters'))
  return (
    <span className="ds-pills" data-wrap="">
      {values.map((value) => {
        const filter = trackFilter({ field, value })
        const current = active.find((item) => sameBrowseFilter(item, filter))
        const mode = current ? (current.mode ?? 'any') : undefined
        const label = formatBrowseFilterValue(field, value)
        const action = sourcesFor && (
          <MetadataSourceControl
            field={field}
            name={value}
            resource={{ kind: 'track', id: sourcesFor }}
          />
        )
        return onFilter ? (
          <FilterPill
            key={value}
            label={label}
            mode={mode}
            title={`Filter ${field}: ${label}. Shift-click to keep details open.`}
            onClick={(event) => onFilter(filter, event.shiftKey)}
            workspaceHref={filterHref(filter)}
            action={action}
          />
        ) : (
          <FilterPill
            key={value}
            label={label}
            mode={mode}
            href={tracksHref([filter])}
            action={action}
          />
        )
      })}
    </span>
  )
}

/**
 * The track's album warnings, its Spotify and TIDAL matches, its Sonovault
 * references and the Last.fm names that count towards it.
 */
function TrackSources({
  item,
  albumAddition,
  onResolved,
}: {
  item: TrackDetail
  albumAddition: ReturnType<typeof useTrackAlbumAddition>
  onResolved?: (targetId: string) => void
}) {
  return (
    <>
      <TrackAlbumNotices item={item} addition={albumAddition} />
      <TrackSpotifySource key={item.id} item={item} onResolved={onResolved} />
      <TrackTidalSource key={`tidal-${item.id}`} item={item} />
      <TrackSonovaultSource key={`sonovault-${item.id}`} item={item} />
      <TrackLastfmSources item={item} onResolved={onResolved} />
    </>
  )
}

const tempoField = trackBrowseFields.find((field) => field.key === 'bpm')

function factTempo(fact: TrackFact) {
  if (fact.bpm === null) return null
  return tempoField ? formatBrowseValue(tempoField, fact.bpm) : `${fact.bpm}`
}

function factKey(fact: TrackFact, notation: KeyNotation) {
  if (!fact.keyCamelot) return null
  const stored =
    notation === 'musical'
      ? fact.keyMusical
      : notation === 'open'
        ? fact.keyOpen
        : fact.keyCamelot
  return stored ?? formatMusicalKey(fact.keyCamelot, notation)
}

/** Each provider's value with its source; an unverified record is marked. */
function TrackFactValues({
  facts,
  value,
}: {
  facts: TrackFact[]
  value: (fact: TrackFact) => string | null
}) {
  const shown = facts.flatMap((fact) => {
    const text = value(fact)
    return text === null ? [] : [{ fact, text }]
  })
  if (!shown.length) return EMPTY_VALUE
  return shown.map(({ fact, text }) => {
    const source = fact.verified
      ? providerLabel(fact.provider)
      : `${providerLabel(fact.provider)} · may be another version`
    return (
      <div
        key={fact.provider}
        className="ds-truncate"
        title={`${text} ${source}, fetched ${formatDate(fact.fetchedAt)}`}
      >
        <span className="ds-num">{text}</span>{' '}
        <span className="ds-muted">{source}</span>
      </div>
    )
  })
}

/**
 * TTAG-11: the track's own tags first, with Sonovault's unverified tags and
 * the ones the owner removed listed apart. Edit tags adds and removes them.
 */
function TrackTags({
  item,
  onFilter,
  filterHref,
}: {
  item: TrackDetail
  onFilter?: OnFilter
  filterHref: BrowseFilterHref
}) {
  const [editing, setEditing] = useState(false)
  const edits = useTrackTagEdits(item.id)
  const { own, unverified, removed } = item.tags
  const sources = (name: string) => (
    <MetadataSourceControl
      field="trackTag"
      name={name}
      resource={{ kind: 'track', id: item.id }}
    />
  )
  const others = [
    ...(unverified.length
      ? [
          {
            label: 'Sonovault, may be another version',
            value: (
              <span className="ds-pills" data-wrap="">
                {unverified.map((tag) => (
                  <Pill asChild size="md" key={tag.id}>
                    <span className="browse-filter-pill">
                      <PillLabel>{formatTagName(tag.name)}</PillLabel>
                      {sources(tag.name)}
                    </span>
                  </Pill>
                ))}
              </span>
            ),
          },
        ]
      : []),
    ...(removed.length
      ? [
          {
            label: 'Removed by you',
            value: removed.map((tag) => (
              <div key={tag.id}>
                <span>{formatTagName(tag.name)}</span>{' '}
                <Button
                  variant="link"
                  size="xs"
                  disabled={edits.isPending}
                  aria-label={`Restore ${formatTagName(tag.name)}`}
                  onClick={() => edits.mutate({ kind: 'add', tagId: tag.id })}
                >
                  Restore
                </Button>
              </div>
            )),
          },
        ]
      : []),
  ]
  return (
    <Section
      title="Track tags"
      aside={
        <Button variant="link" size="xs" onClick={() => setEditing(!editing)}>
          {editing ? 'Done' : 'Edit tags'}
        </Button>
      }
    >
      {editing ? (
        own.length > 0 && (
          <span className="ds-pills" data-wrap="">
            {own.map((tag) => (
              <BrowseFilterPill
                key={tag.id}
                removeLabel={`Remove ${formatTagName(tag.name)}`}
                onRemove={() => edits.mutate({ kind: 'remove', tagId: tag.id })}
              >
                {formatTagName(tag.name)}
              </BrowseFilterPill>
            ))}
          </span>
        )
      ) : own.length ? (
        <FilterValues
          field="trackTag"
          values={own.map((tag) => tag.name)}
          onFilter={onFilter}
          filterHref={filterHref}
          sourcesFor={item.id}
        />
      ) : (
        <span className="ds-muted">{EMPTY_VALUE}</span>
      )}
      {others.map((group) => (
        <div className="dtl-stack" key={group.label}>
          <span className="ds-label">{group.label}</span>
          <div>{group.value}</div>
        </div>
      ))}
      {editing && <TrackTagEditor tags={item.tags} edits={edits} />}
    </Section>
  )
}

function TrackOverview({
  item,
  albumAddition,
  onFilter,
  filterHref,
  onResolved,
  showSources,
  sourcesHref,
}: {
  item: TrackDetail
  albumAddition: ReturnType<typeof useTrackAlbumAddition>
  onFilter?: OnFilter
  filterHref: BrowseFilterHref
  onResolved: (id: string) => void
  showSources: () => void
  sourcesHref: string
}) {
  const notation = useKeyNotation()
  const facts = item.facts.length
    ? [
        {
          label: 'Tempo',
          value: <TrackFactValues facts={item.facts} value={factTempo} />,
        },
        {
          label: 'Key',
          value: (
            <TrackFactValues
              facts={item.facts}
              value={(fact) => factKey(fact, notation)}
            />
          ),
        },
      ]
    : []
  const artistTags = musicDisplayTags(item.albumTags, item.artistTags)
    .filter((tag) => tag.source === 'artist')
    .map((tag) => tag.name)
  const sourcesLabel =
    item.spotifyMatch === 'unmatched' && !item.spotifyAlternate
      ? 'Match to Spotify'
      : 'View source details'
  const tags = [
    {
      label: 'Album tags',
      field: 'albumTag',
      values: item.albumTags,
    },
    {
      label: 'Artist tags',
      field: 'artistTag',
      values: artistTags,
    },
  ].filter((group) => group.values.length > 0)
  return (
    <div className="dtl-overview">
      <div className="dtl-main">
        <Section flush>
          <ListeningStats
            kind="track"
            id={item.id}
            trendOn="scrobbles"
            items={[
              { label: 'scrobbles', value: formatCount(item.scrobbles) },
              { label: 'last played', value: formatDate(item.lastListenedAt) },
              { label: 'added', value: formatDate(item.dateAdded) },
            ]}
          />
        </Section>
        <ListeningTrend kind="track" id={item.id} />
        <TrackAppearances
          item={item}
          albumAddition={albumAddition}
          onResolved={onResolved}
        />
      </div>
      <div className="dtl-side">
        <TrackTags item={item} onFilter={onFilter} filterHref={filterHref} />
        {tags.map((group) => (
          <Section key={group.field} title={group.label}>
            <FilterValues
              field={group.field}
              values={group.values}
              onFilter={onFilter}
              filterHref={filterHref}
              sourcesFor={item.id}
            />
          </Section>
        ))}
        <Section
          title="Details"
          aside={
            <Button
              {...workspaceTabLinkProps(sourcesHref, sourcesLabel)}
              variant="link"
              size="xs"
              onClick={showSources}
            >
              {sourcesLabel}
            </Button>
          }
        >
          <Facts
            items={[
              {
                label: 'Length',
                value: formatTrackLength(
                  item.durationSec === null ? null : item.durationSec * 1000,
                ),
              },
              ...facts,
              {
                label: 'Released',
                value: item.releaseDate?.slice(0, 10) ?? EMPTY_VALUE,
              },
              { label: 'Added', value: formatDate(item.dateAdded) },
              {
                label: 'ISRC',
                value: item.isrcs.length ? (
                  item.isrcs.map((code) => {
                    const providers = code.providers
                      .map((provider) => providerLabel(provider))
                      .join(', ')
                    return (
                      <div
                        key={code.isrc}
                        className="ds-truncate"
                        title={`${code.isrc} ${providers}`}
                      >
                        <span className="ds-mono">{code.isrc}</span>{' '}
                        <span className="ds-muted">{providers}</span>
                      </div>
                    )
                  })
                ) : item.isrc ? (
                  <span className="ds-mono">{item.isrc}</span>
                ) : (
                  EMPTY_VALUE
                ),
              },
              {
                label: 'Source',
                value: item.sources.length ? (
                  <FilterValues
                    field="source"
                    values={item.sources.map(
                      (source) => trackSourceLabels[source],
                    )}
                    onFilter={onFilter}
                    filterHref={filterHref}
                  />
                ) : (
                  EMPTY_VALUE
                ),
              },
              {
                label: 'Spotify match',
                value: (
                  <FilterValues
                    field="spotifyMatch"
                    values={[trackSpotifyMatchLabels[item.spotifyMatch]]}
                    onFilter={onFilter}
                    filterHref={filterHref}
                  />
                ),
              },
            ]}
          />
        </Section>
      </div>
    </div>
  )
}

export default function TrackDetailView({
  id,
  onFilter,
  filterHref = (filter) => tracksHref([filter]),
  onMerged,
}: {
  id: string
  /** Applies a filter in the surrounding browser; without it values link to /tracks. */
  onFilter?: OnFilter
  filterHref?: BrowseFilterHref
  /** Opens the retained track after a merge or a source correction. */
  onMerged?: (targetId: string, tab?: 'sources') => void
}) {
  const { apiBaseUrl } = useConfig()
  const detail = useQuery({
    queryKey: ['track', id],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/tracks/${encodeURIComponent(id)}`,
        TrackDetailSchema,
      ),
  })
  useDetailPerformance('tracks', id, detail)
  if (!detail.data)
    return (
      <CreatorDetailState
        pending={detail.isPending}
        retry={() => detail.refetch()}
        subject="track"
      />
    )
  return (
    <TrackDetailContent
      key={detail.data.id}
      item={detail.data}
      onFilter={onFilter}
      filterHref={filterHref}
      onMerged={onMerged}
      stale={detail.isRefetchError}
      retry={() => detail.refetch()}
    />
  )
}

function TrackDetailContent({
  item,
  onFilter,
  filterHref,
  onMerged,
  stale,
  retry,
}: {
  item: TrackDetail
  onFilter?: OnFilter
  filterHref: BrowseFilterHref
  onMerged?: (targetId: string, tab?: 'sources') => void
  stale: boolean
  retry: () => void
}) {
  const { tab, setTab, tabHref } = useDetailTab(trackTabs, {
    aliases: trackTabAliases,
  })
  const [merging, setMerging] = useState(false)
  const albumAddition = useTrackAlbumAddition(item)
  function openResolvedTrack(targetId: string, tab?: 'sources') {
    if (onMerged) onMerged(targetId, tab)
    else
      window.location.assign(
        `/tracks/${encodeURIComponent(targetId)}${tab ? `?tab=${tab}` : ''}`,
      )
  }
  return (
    <article className="dtl-detail">
      {stale && <CreatorDetailState stale retry={retry} subject="track" />}
      <TrackDetailHeader
        track={item}
        titleAction={
          <TrackSpotifyMatchAction
            track={item}
            hasAlternate={Boolean(item.spotifyAlternate)}
            onMatched={(targetId) => {
              if (targetId !== item.id) openResolvedTrack(targetId)
            }}
          />
        }
        artistHref={(value) => filterHref({ field: 'artist', value })}
        album={
          albumAddition.name &&
          (albumAddition.catalogId || albumAddition.openBySpotify ? (
            <TrackAlbumReferenceLink item={item} addition={albumAddition}>
              {albumAddition.name}
            </TrackAlbumReferenceLink>
          ) : item.albumName ? (
            <span {...albumShortcut(item.albumName, filterHref)}>
              {item.albumName}
            </span>
          ) : null)
        }
        links={trackServiceLinks(item)}
        actions={
          <>
            <CatalogLibraryAction
              key={item.id}
              id={item.id}
              kind="track"
              title={item.title}
              inLibrary={item.inLibrary ?? true}
            />
            <DetailActionsSpacer />
            <DetailMore
              crumb={{ title: item.title }}
              items={
                canMergeLastfmTrack(item)
                  ? [
                      {
                        label: 'Merge with Spotify track',
                        onSelect: () => setMerging(true),
                      },
                    ]
                  : []
              }
            />
          </>
        }
      />
      {merging && canMergeLastfmTrack(item) && (
        <TrackMergePanel
          key={item.id}
          track={item}
          onClose={() => setMerging(false)}
          onMerged={(targetId) => openResolvedTrack(targetId)}
        />
      )}
      <TrackDuplicateNotice
        key={`duplicates-${item.id}`}
        trackId={item.id}
        onResolved={(targetId) => openResolvedTrack(targetId)}
      />
      <DetailTabs
        label="Track details"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'similar', label: 'Similar' },
          { value: 'sources', label: 'Sources' },
        ]}
      >
        <TabsContent value="overview">
          <TrackOverview
            item={item}
            albumAddition={albumAddition}
            onFilter={onFilter}
            filterHref={filterHref}
            onResolved={openResolvedTrack}
            showSources={() => setTab('sources')}
            sourcesHref={tabHref('sources')}
          />
        </TabsContent>
        <TabsContent value="similar">
          <SimilarItems key={item.id} kind="track" id={item.id} />
        </TabsContent>
        <TabsContent value="sources">
          <TrackRecordParts
            key={`parts-${item.id}`}
            item={item}
            onResolved={(targetId) => openResolvedTrack(targetId, 'sources')}
          />
          <TrackSources
            key={item.id}
            item={item}
            albumAddition={albumAddition}
            onResolved={(targetId) => openResolvedTrack(targetId, 'sources')}
          />
          <LibraryRecordChanges
            key={`changes-${item.id}`}
            kind="track"
            recordId={item.id}
            onResolved={(targetId) => openResolvedTrack(targetId, 'sources')}
          />
        </TabsContent>
      </DetailTabs>
    </article>
  )
}
