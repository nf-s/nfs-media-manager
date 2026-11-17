'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Disc3, Film } from 'lucide-react'
import { z } from 'zod'
import { musicDisplayTags } from '@repo/schemas/music-tags'
import {
  AlbumDetailSchema,
  FilmDetailSchema,
  AlbumPatchSchema,
  FilmPatchSchema,
  parseAlbumBrowseFiltersParam,
  type AlbumDetail,
  type FilmDetail,
} from '@repo/schemas/media'
import {
  BrowseFieldSchema,
  getBrowseValues,
  formatBrowseValue,
  filmIdentificationStatus,
  albumBrowseFields,
  filmBrowseFields,
  sameBrowseFilter,
  type BrowseField,
  type BrowseFilter,
  type BrowseValues,
} from '@repo/schemas/browse'
import {
  DetailHeader,
  DetailActionsSpacer,
} from '@repo/ui/components/ds/detail-header'
import { Notice } from '@repo/ui/components/ds/feedback'
import {
  Facts,
  KeyValues,
  Section,
  type StatItem,
} from '@repo/ui/components/ds/facts'
import { Status } from '@repo/ui/components/ds/status'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { TabsContent } from '@repo/ui/components/ui/tabs'
import {
  EMPTY_VALUE,
  formatCount,
  formatDate,
  formatItemCount,
  formatRuntime,
  formatTrackLength,
} from '@repo/ui/lib/format'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { invalidateMediaItem } from '@/utils/query-cache'
import { withoutDetailEntries } from '@/utils/detail-inspector'
import { scopedHref } from '@/utils/media-scope'
import { createAlbumPlaybackSource } from '@/utils/playback-source'
import { getDetailProviderLinks, ratingScore } from '@/utils/provider-ratings'
import { albumSpotifyDestination } from '@/utils/album-links'
import MediaSources, { MediaEditHistory } from './media-sources'
import { BrowseFilterChips } from './browse-controls'
import { FilterIndicator } from './filter-affordance'
import { CreatorLinks } from './creator-links'
import { CreatorDetailState } from './creator-detail-state'
import { FilmCollectionLinks } from './film-collection-links'
import AlbumListening from './album-listening'
import { ListeningStats } from './listening-stats'
import AlbumPlaylists from './album-playlists'
import AlbumTracksTable from './album-tracks-table'
import { FieldProvenance } from './field-provenance'
import ServiceIconLinks, { serviceLinks } from './service-icon-links'
import { AlbumHeaderPlay } from './detail-play'
import { DetailMore } from './detail-more'
import { WatchedToggle } from './watched-button'
import {
  DetailArt,
  DetailTabs,
  FilterPill,
  OpenAtProvider,
  RatingCards,
  ratingSource,
  useDetailTab,
} from './detail-frame'

const DetailSchema = z.union([AlbumDetailSchema, FilmDetailSchema])
type OnFilter = (filter: BrowseFilter, keepOpen?: boolean) => void

type AlbumTab = 'overview' | 'listening' | 'sources' | 'edit'
type FilmTab = 'overview' | 'sources' | 'edit'
const albumTabs: readonly [AlbumTab, ...AlbumTab[]] = [
  'overview',
  'listening',
  'sources',
  'edit',
]
const filmTabs: readonly [FilmTab, ...FilmTab[]] = [
  'overview',
  'sources',
  'edit',
]
/** Older links opened the album's contents on their own tabs. */
const tabAliases = {
  history: 'sources',
  tracks: 'overview',
  playlists: 'overview',
} satisfies Record<string, 'overview' | 'sources'>

/** Release dates are calendar days; they are shown as stored. */
function releaseDay(value: string | null) {
  return value ? value.slice(0, 10) : null
}

function fieldValue(
  field: BrowseField,
  value: BrowseValues[string] | undefined,
) {
  const formatted = formatBrowseValue(field, value)
  return formatted === '-' ? EMPTY_VALUE : formatted
}

/** Values that filter the library when clicked; shift-click keeps details open. */
function FilterPills({
  field,
  values,
  onFilter,
  selected,
  max,
}: {
  field: string
  values: readonly string[]
  onFilter: OnFilter
  selected: readonly BrowseFilter[]
  /** Shows this many, then a button for the rest. */
  max?: number
}) {
  const [all, setAll] = useState(false)
  const shown = max === undefined || all ? values : values.slice(0, max)
  const hidden = values.length - shown.length
  return (
    <span className="ds-pills" data-wrap="">
      {shown.map((value) => {
        const active = selected.find((filter) =>
          sameBrowseFilter(filter, { field, value }),
        )
        return (
          <FilterPill
            key={value}
            label={value}
            mode={active ? (active.mode ?? 'any') : undefined}
            title={`Filter ${field}: ${value}. Shift-click to keep details open.`}
            onClick={(event) => onFilter({ field, value }, event.shiftKey)}
          />
        )
      })}
      {hidden > 0 && (
        <Button variant="link" size="xs" onClick={() => setAll(true)}>
          +{formatCount(hidden)} more
        </Button>
      )}
    </span>
  )
}

/** Six facts and an "All fields" disclosure with the source of every field. */
function DetailsSection({
  mediaItemId,
  facts,
}: {
  mediaItemId: string
  facts: readonly { label: string; value: ReactNode }[]
}) {
  const [open, setOpen] = useState(false)
  return (
    <Section
      title="Details"
      aside={
        <Button
          variant="link"
          size="xs"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Hide fields' : 'All fields'}
        </Button>
      }
    >
      <Facts items={facts.slice(0, 6)} />
      {open && <FieldProvenance mediaItemId={mediaItemId} />}
    </Section>
  )
}

/**
 * Pins the browse sort field first among the facts, when it is not already
 * shown, so the value the list is ordered by is visible.
 */
function withSortedFact(
  facts: { key: string; label: string; value: ReactNode }[],
  fields: readonly BrowseField[],
  values: BrowseValues,
  highlightField: string | undefined,
  shown: readonly string[],
) {
  const field = fields.find((item) => item.key === highlightField)
  const value = field ? values[field.key] : undefined
  if (
    !field ||
    value === undefined ||
    value === null ||
    shown.includes(field.key) ||
    facts.some((fact) => fact.key === field.key)
  )
    return facts
  return [
    { key: field.key, label: field.label, value: fieldValue(field, value) },
    ...facts,
  ]
}

function EditMedia({
  item,
  onSaved,
}: {
  item: AlbumDetail | FilmDetail
  onSaved: () => Promise<void>
}) {
  const { apiBaseUrl } = useConfig()
  const [error, setError] = useState('')
  const collection = item.mediaType === 'album' ? 'albums' : 'films'
  const baseline = Object.fromEntries(Object.entries(item))
  if (item.mediaType === 'album' && item.storedDateAdded !== undefined)
    baseline.dateAdded = item.storedDateAdded
  const fields = [
    { key: 'title', label: 'Title', type: 'text' },
    { key: 'originalTitle', label: 'Original title', type: 'text' },
    { key: 'artworkUrl', label: 'Artwork URL', type: 'url' },
    { key: 'sourceLabel', label: 'Source', type: 'text' },
    { key: 'releaseDate', label: 'Release date', type: 'date' },
    {
      key: 'dateAdded',
      label: item.mediaType === 'album' ? 'Stored date added' : 'Date added',
      type: 'date',
    },
    ...(item.mediaType === 'album'
      ? [
          { key: 'durationSec', label: 'Duration (seconds)', type: 'number' },
          { key: 'spotifyUrl', label: 'Spotify URL', type: 'url' },
        ]
      : [
          { key: 'runtimeMinutes', label: 'Runtime (minutes)', type: 'number' },
          { key: 'sourceKind', label: 'Source kind', type: 'text' },
          { key: 'budget', label: 'Budget', type: 'number' },
          { key: 'boxOffice', label: 'Box office', type: 'number' },
        ]),
  ]
  const mutation = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/${collection}/${item.id}`,
        DetailSchema,
        {
          method: 'PATCH',
          body: JSON.stringify(
            item.mediaType === 'album'
              ? AlbumPatchSchema.parse(patch)
              : FilmPatchSchema.parse(patch),
          ),
        },
      ),
    onSuccess: onSaved,
  })
  return (
    <form
      className="dtl-form"
      onSubmit={(event) => {
        event.preventDefault()
        setError('')
        const data = new FormData(event.currentTarget)
        const patch: Record<string, unknown> = {}
        for (const field of [...fields, { key: 'summary', type: 'text' }]) {
          const raw = data.get(field.key)
          const input = typeof raw === 'string' ? raw.trim() : ''
          const before = baseline[field.key]
          const displayBefore =
            before === null || before === undefined
              ? ''
              : field.type === 'date' && typeof before === 'string'
                ? before.slice(0, 10)
                : String(before)
          if (input !== displayBefore)
            patch[field.key] =
              input === ''
                ? null
                : field.type === 'number'
                  ? Number(input)
                  : input
        }
        if (
          item.mediaType === 'film' &&
          (data.get('watched') === 'on') !== item.watched
        )
          patch.watched = data.get('watched') === 'on'
        const note = data.get('note')
        if (typeof note === 'string' && note.trim()) patch.note = note.trim()
        if (!Object.keys(patch).length) {
          setError('No changes.')
          return
        }
        mutation.mutate(patch)
      }}
    >
      <div className="dtl-form-grid">
        {fields.map((field) => {
          const raw = baseline[field.key]
          const value =
            raw === null || raw === undefined
              ? ''
              : field.type === 'date' && typeof raw === 'string'
                ? raw.slice(0, 10)
                : String(raw)
          return (
            <label key={field.key} className="ds-field">
              <span className="ds-label">{field.label}</span>
              <Input
                name={field.key}
                type={field.type}
                controlSize="md"
                required={field.key === 'title'}
                min={field.type === 'number' ? 0 : undefined}
                defaultValue={value}
              />
            </label>
          )
        })}
      </div>
      {item.mediaType === 'album' && (
        <p className="ds-help">
          An earlier first Last.fm scrobble is used for Added in the library.
          The stored date is kept.
        </p>
      )}
      <label className="ds-field">
        <span className="ds-label">Summary</span>
        <textarea
          className="ds-input dtl-textarea"
          name="summary"
          defaultValue={item.summary ?? ''}
          rows={3}
        />
      </label>
      {item.mediaType === 'film' && (
        <label className="ds-checkrow">
          <input
            className="ds-check"
            type="checkbox"
            name="watched"
            defaultChecked={item.watched}
          />
          Watched
        </label>
      )}
      <label className="ds-field">
        <span className="ds-label">Note</span>
        <Input name="note" controlSize="md" />
      </label>
      <div className="ds-actions">
        <Button
          size="md"
          variant="primary"
          disabled={mutation.isPending}
          type="submit"
        >
          {mutation.isPending ? 'Saving...' : 'Save changes'}
        </Button>
        <span role="status" className="ds-muted">
          {mutation.isSuccess ? 'Saved' : error}
        </span>
        {mutation.isError && (
          <span role="alert">Could not save. Check the values and retry.</span>
        )}
      </div>
    </form>
  )
}

/** Marks a film watched or unwatched from its header. */
function WatchedButton({ item }: { item: FilmDetail }) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const mutation = useMutation({
    mutationFn: (watched: boolean) =>
      fetchApiData(apiBaseUrl, `/api/v1/films/${item.id}`, DetailSchema, {
        method: 'PATCH',
        body: JSON.stringify(FilmPatchSchema.parse({ watched })),
      }),
    onSuccess: () => invalidateMediaItem(client, 'film', item.id),
  })
  return (
    <WatchedToggle
      watched={item.watched}
      pending={mutation.isPending}
      error={mutation.isError}
      onToggle={() => mutation.mutate(!item.watched)}
    />
  )
}

export default function MediaDetail({
  mediaType,
  id,
  onFilter,
  onFiltersChange,
  highlightField,
  browseMetric,
}: {
  mediaType: 'album' | 'film'
  id: string
  onFilter?: OnFilter
  onFiltersChange?: (filters: BrowseFilter[]) => void
  /** Browse sort field, pinned first among the details. */
  highlightField?: string
  /** Query-specific metric supplied by the browse result, including real zero. */
  browseMetric?: { field: BrowseField; value: number }
}) {
  const { apiBaseUrl } = useConfig()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const collection = mediaType === 'album' ? 'albums' : 'films'
  const matchingBrowse =
    pathname === `/${collection}` || pathname?.startsWith(`/${collection}/`)
  const browseParams = matchingBrowse
    ? withoutDetailEntries(pathname, new URLSearchParams(searchParams))
    : new URLSearchParams()
  const selectedFilters = parseAlbumBrowseFiltersParam(
    browseParams.get('filters'),
  )
  const queryClient = useQueryClient()
  const albumTab = useDetailTab(albumTabs, { aliases: tabAliases })
  const filmTab = useDetailTab(filmTabs, { aliases: tabAliases })
  const { tab, setTab } = mediaType === 'album' ? albumTab : filmTab
  const [saved, setSaved] = useState(false)
  const detail = useQuery({
    queryKey: [mediaType, id],
    queryFn: () =>
      fetchApiData(apiBaseUrl, `/api/v1/${collection}/${id}`, DetailSchema),
  })
  const fields = useQuery({
    queryKey: [collection, 'fields'],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/${collection}/fields`,
        z.array(BrowseFieldSchema),
      ),
  })
  async function onSaved() {
    await invalidateMediaItem(queryClient, mediaType, id)
    setSaved(true)
  }
  function filter(value: BrowseFilter, keepOpen = false) {
    if (onFilter) {
      onFilter(value, keepOpen)
      return
    }
    const next = selectedFilters.some((item) => sameBrowseFilter(item, value))
      ? selectedFilters
      : [...selectedFilters, value]
    const params = keepOpen
      ? new URLSearchParams(window.location.search)
      : browseParams
    params.set('filters', JSON.stringify(next))
    if (keepOpen)
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}?${params}`,
      )
    else window.location.assign(`/${collection}?${params}`)
  }
  function changeFilters(next: BrowseFilter[]) {
    if (onFiltersChange) {
      onFiltersChange(next)
      return
    }
    const params = new URLSearchParams(window.location.search)
    // An explicit empty selection prevents browse preferences restoring removed filters.
    params.set('filters', JSON.stringify(next))
    params.delete('page')
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${params.size ? `?${params}` : ''}`,
    )
  }
  const subject = mediaType === 'album' ? 'album' : 'film'
  if (!detail.data)
    return (
      <CreatorDetailState
        pending={detail.isPending}
        retry={() => detail.refetch()}
        subject={subject}
      />
    )
  const item = detail.data
  const values: BrowseValues = {
    ...getBrowseValues(item),
    ...(browseMetric ? { [browseMetric.field.key]: browseMetric.value } : {}),
  }
  const baseFields =
    fields.data ??
    (mediaType === 'album' ? albumBrowseFields : filmBrowseFields)
  const browseFields = browseMetric
    ? [
        browseMetric.field,
        ...baseFields.filter((field) => field.key !== browseMetric.field.key),
      ]
    : baseFields
  const providers = getDetailProviderLinks(
    browseFields,
    values,
    item.links,
    item.mediaType === 'album' ? albumSpotifyDestination(item) : undefined,
    item.providerReferences,
  )
  const [primaryLink, ...otherLinks] = serviceLinks(providers.links)
  const creators = item.credits.filter(
    (credit) => credit.role === (mediaType === 'album' ? 'artist' : 'director'),
  )
  const needsId =
    item.mediaType === 'film' &&
    filmIdentificationStatus(item.providerReferences) === 'Needs ID'
  const textValues = (key: string) => {
    const value = values[key]
    return Array.isArray(value)
      ? value
      : typeof value === 'string' && value
        ? [value]
        : []
  }

  const header = (
    <DetailHeader
      art={
        <DetailArt
          src={item.artworkUrl}
          ratio={item.mediaType === 'film' ? 'poster' : undefined}
          fallback={
            item.mediaType === 'film' ? (
              <Film className="ds-i" aria-hidden="true" />
            ) : (
              <Disc3 className="ds-i" aria-hidden="true" />
            )
          }
        />
      }
      kind={item.mediaType === 'album' ? 'Album' : 'Film'}
      title={item.title}
      by={
        creators.length > 0 && (
          <>
            {item.mediaType === 'album' ? 'by ' : 'directed by '}
            <CreatorLinks
              creators={creators}
              kind={item.mediaType === 'album' ? 'artist' : 'person'}
            />
          </>
        )
      }
      facts={[
        item.originalTitle && item.originalTitle !== item.title
          ? item.originalTitle
          : null,
        releaseDay(item.releaseDate),
        item.mediaType === 'album'
          ? item.trackCount
            ? `${formatCount(item.trackCount)} ${item.trackCount === 1 ? 'track' : 'tracks'}`
            : null
          : null,
        item.mediaType === 'album'
          ? item.durationSec === null
            ? null
            : formatTrackLength(item.durationSec * 1000)
          : item.runtimeMinutes
            ? formatRuntime(item.runtimeMinutes)
            : null,
        item.mediaType === 'film' ? textValues('country')[0] : null,
        needsId ? <Status state="attention">Needs ID</Status> : null,
      ]}
      actions={
        <>
          {item.mediaType === 'album' ? (
            <AlbumHeaderPlay
              album={item}
              source={() =>
                createAlbumPlaybackSource(
                  item,
                  `${window.location.pathname}${window.location.search}`,
                )
              }
            />
          ) : (
            <WatchedButton item={item} />
          )}
          {needsId && (
            <Button size="md" onClick={() => setTab('sources')}>
              Identify film
            </Button>
          )}
          <DetailActionsSpacer />
          {otherLinks.length > 0 && <ServiceIconLinks links={otherLinks} />}
          {primaryLink && (
            <OpenAtProvider label={primaryLink.label} url={primaryLink.url} />
          )}
          <DetailMore
            crumb={{ title: item.title }}
            items={[{ label: 'Edit', onSelect: () => setTab('edit') }]}
          />
        </>
      }
    />
  )

  const tagSection = (
    sections: {
      label: string
      field: string
      values: string[]
      max?: number
    }[],
  ) => {
    const shown = sections.filter((section) => section.values.length > 0)
    return shown.map((section, index) => (
      <Section
        key={section.label}
        title={section.label}
        aside={
          index === 0 && (
            <Button variant="link" size="xs" asChild>
              <Link href={scopedHref('/tags', item.mediaType)}>
                Manage tags
              </Link>
            </Button>
          )
        }
      >
        <FilterPills
          field={section.field}
          values={section.values}
          max={section.max}
          onFilter={filter}
          selected={selectedFilters}
        />
      </Section>
    ))
  }

  let overview: ReactNode
  if (item.mediaType === 'album') {
    const ratings = providers.ratings.filter(
      (rating) => rating.score !== undefined,
    )
    const scrobbles = values.scrobbles
    const lastListened = values.lastListenedAt
    const stats: StatItem[] = [
      ...(browseMetric && browseMetric.field.key !== 'scrobbles'
        ? [
            {
              label: browseMetric.field.label,
              value: fieldValue(browseMetric.field, browseMetric.value),
            },
          ]
        : []),
      {
        label: 'scrobbles',
        value: typeof scrobbles === 'number' ? formatCount(scrobbles) : '0',
      },
      ...ratings.slice(0, 2).map((rating) => ({
        label: ratingSource(rating),
        value: ratingScore(rating),
      })),
      {
        label: 'last played',
        value:
          typeof lastListened === 'number'
            ? formatDate(lastListened)
            : EMPTY_VALUE,
      },
    ]
    const artistTags = musicDisplayTags(
      item.tags.map((tag) => tag.name),
      item.artistTags,
    )
      .filter((tag) => tag.source === 'artist')
      .map((tag) => tag.name)
    const dateAdded = values.dateAdded
    const source = textValues('source')[0]
    const facts = withSortedFact(
      [
        {
          key: 'releaseDate',
          label: 'Released',
          value: releaseDay(item.releaseDate) ?? EMPTY_VALUE,
        },
        {
          key: 'dateAdded',
          label: 'Added',
          value: (
            <span title={item.dateAddedSource}>
              {typeof dateAdded === 'number'
                ? formatDate(dateAdded)
                : EMPTY_VALUE}
            </span>
          ),
        },
        {
          key: 'source',
          label: 'Source',
          value: source ? (
            <FilterPills
              field="source"
              values={[source]}
              onFilter={filter}
              selected={selectedFilters}
            />
          ) : (
            EMPTY_VALUE
          ),
        },
        {
          key: 'country',
          label: 'Country',
          value: textValues('country').join(', ') || EMPTY_VALUE,
        },
        {
          key: 'durationSec',
          label: 'Duration',
          value: formatTrackLength(
            item.durationSec === null ? null : item.durationSec * 1000,
          ),
        },
        {
          key: 'trackCount',
          label: 'Tracks',
          value: formatCount(item.trackCount),
        },
      ],
      browseFields,
      values,
      highlightField,
      [
        'scrobbles',
        'lastListenedAt',
        ...ratings.slice(0, 2).map((rating) => rating.key),
      ],
    )
    overview = (
      <div className="dtl-overview">
        <div className="dtl-main">
          <Section flush>
            <ListeningStats
              kind="album"
              id={item.id}
              trendOn="scrobbles"
              items={stats.slice(0, 4)}
            />
          </Section>
          {item.summary && (
            <Section title="About">
              <p className="dtl-text">{item.summary}</p>
            </Section>
          )}
          <Section
            title="Tracks"
            note={[
              formatCount(item.tracks.length),
              item.durationSec === null
                ? null
                : formatTrackLength(item.durationSec * 1000),
            ]
              .filter(Boolean)
              .join(' · ')}
          >
            <AlbumTracksTable album={item} />
          </Section>
        </div>
        <div className="dtl-side">
          {tagSection([
            {
              label: 'Album tags',
              field: 'genre',
              values: item.tags.map((tag) => tag.name),
            },
            { label: 'Artist tags', field: 'artistTag', values: artistTags },
          ])}
          <AlbumPlaylists key={item.id} albumId={item.id} />
          <DetailsSection mediaItemId={item.id} facts={facts} />
        </div>
      </div>
    )
  } else {
    const credited = (role: string) =>
      item.credits.filter((credit) => credit.role === role)
    const cast: { label: string; role: string; max?: number }[] = [
      { label: 'Directors', role: 'director' },
      { label: 'Writers', role: 'writer' },
      { label: 'Cast', role: 'actor', max: 8 },
    ]
    const people = cast
      .map((group) => ({ ...group, credits: credited(group.role) }))
      .filter((group) => group.credits.length > 0)
    const genres = item.tags
      .filter((tag) => tag.kind === 'genre')
      .map((tag) => tag.name)
    const keywords = item.tags
      .filter((tag) => tag.kind !== 'genre')
      .map((tag) => tag.name)
    const dateAdded = values.dateAdded
    const facts = withSortedFact(
      [
        {
          key: 'releaseDate',
          label: 'Released',
          value: releaseDay(item.releaseDate) ?? EMPTY_VALUE,
        },
        {
          key: 'runtimeMinutes',
          label: 'Runtime',
          value: formatRuntime(item.runtimeMinutes),
        },
        {
          key: 'country',
          label: 'Country',
          value: textValues('country').join(', ') || EMPTY_VALUE,
        },
        {
          key: 'language',
          label: 'Language',
          value: textValues('language').join(', ') || EMPTY_VALUE,
        },
        {
          key: 'dateAdded',
          label: 'Added',
          value: (
            <span title={item.dateAddedSource}>
              {typeof dateAdded === 'number'
                ? formatDate(dateAdded)
                : EMPTY_VALUE}
            </span>
          ),
        },
        {
          key: 'watched',
          label: 'Watched',
          value: item.watched ? 'Yes' : 'No',
        },
      ],
      browseFields,
      values,
      highlightField,
      providers.ratings.map((rating) => rating.key),
    )
    const collections = item.playlists.filter(
      (playlist) => playlist.kind === 'collection',
    )
    overview = (
      <div className="dtl-overview">
        <div className="dtl-main">
          {providers.ratings.some((rating) => rating.score !== undefined) && (
            <Section title="Ratings" flush>
              <RatingCards ratings={providers.ratings} />
            </Section>
          )}
          {item.summary && (
            <Section title="Synopsis">
              <p className="dtl-text">{item.summary}</p>
            </Section>
          )}
          {people.length > 0 && (
            <Section title="Cast and crew">
              <KeyValues
                items={people.map((group) => ({
                  label: group.label,
                  value: <CastPills credits={group.credits} max={group.max} />,
                }))}
              />
            </Section>
          )}
        </div>
        <div className="dtl-side">
          {tagSection([
            { label: 'Genres', field: 'genre', values: genres },
            { label: 'Keywords', field: 'genre', values: keywords, max: 6 },
          ])}
          <DetailsSection mediaItemId={item.id} facts={facts} />
          {collections.length > 0 && (
            <Section title="Collections">
              <FilmCollectionLinks
                item={item}
                activeFilters={selectedFilters}
                pills
              />
            </Section>
          )}
        </div>
      </div>
    )
  }

  return (
    <article className="dtl-detail">
      {detail.isRefetchError && (
        <CreatorDetailState
          stale
          retry={() => detail.refetch()}
          subject={subject}
        />
      )}
      {header}
      {selectedFilters.length > 0 && (
        <div className="dtl-filters">
          <Button asChild size="xs">
            <Link href={`/${collection}?${browseParams}`}>
              <FilterIndicator />
              Browse with{' '}
              {formatItemCount(selectedFilters.length, {
                one: 'filter',
                other: 'filters',
              })}
            </Link>
          </Button>
          <BrowseFilterChips
            filters={selectedFilters}
            fields={fields.data ?? []}
            onChange={changeFilters}
          />
        </div>
      )}
      <DetailTabs
        label={item.mediaType === 'album' ? 'Album details' : 'Film details'}
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: 'Overview' },
          ...(item.mediaType === 'album'
            ? [{ value: 'listening', label: 'Listening' }]
            : []),
          { value: 'sources', label: 'Sources' },
          { value: 'edit', label: 'Edit' },
        ]}
      >
        <TabsContent value="overview">{overview}</TabsContent>
        {item.mediaType === 'album' && (
          <TabsContent value="listening">
            <AlbumListening key={item.id} albumId={item.id} />
          </TabsContent>
        )}
        <TabsContent value="sources">
          <MediaSources
            key={item.id}
            item={item}
            onSaved={async () => {
              await invalidateMediaItem(queryClient, mediaType, id)
            }}
          />
        </TabsContent>
        <TabsContent value="edit" onInputCapture={() => setSaved(false)}>
          <EditMedia key={item.updatedAt} item={item} onSaved={onSaved} />
          {saved && <Notice>Changes saved.</Notice>}
          <MediaEditHistory id={item.id} />
        </TabsContent>
      </DetailTabs>
    </article>
  )
}

/** People credited in one role; a long cast shows the first few and a button. */
function CastPills({
  credits,
  max,
}: {
  credits: FilmDetail['credits']
  max?: number
}) {
  const [all, setAll] = useState(false)
  const shown = max === undefined || all ? credits : credits.slice(0, max)
  const hidden = credits.length - shown.length
  return (
    <span className="dtl-pillrow">
      <CreatorLinks creators={shown} kind="person" pills />
      {hidden > 0 && (
        <Button variant="link" size="xs" onClick={() => setAll(true)}>
          +{formatCount(hidden)} more
        </Button>
      )}
    </span>
  )
}
