'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Fragment, useState, type ReactNode } from 'react'
import { useDetailPerformance } from '@/hooks/useDetailPerformance'
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
  formatBrowseFilterValue,
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
import {
  detailPageHref,
  tagDetailId,
  withoutDetailEntries,
} from '@/utils/detail-inspector'
import { workspaceTabLinkProps } from '@/utils/workspace-tab-destination'
import { scopedHref } from '@/utils/media-scope'
import { browseFilterHref, type BrowseFilterHref } from '@/utils/browse-items'
import { createAlbumPlaybackSource } from '@/utils/playback-source'
import {
  getDetailProviderLinks,
  type ProviderRating,
} from '@/utils/provider-ratings'
import { albumSpotifyDestination } from '@/utils/album-links'
import MediaSources, { MediaEditHistory } from './media-sources'
import MetadataSourceControl from './metadata-source-control'
import { BrowseFilterChips } from './browse-controls'
import { FilterIndicator } from './filter-affordance'
import { CreatorLinks } from './creator-links'
import { CreatorDetailState } from './creator-detail-state'
import { CollectionLinks } from './collection-links'
import AlbumListening from './album-listening'
import { ListeningStats } from './listening-stats'
import AlbumPlaylists from './album-playlists'
import AlbumTracksTable from './album-tracks-table'
import { FieldProvenance } from './field-provenance'
import ServiceIconLinks, { serviceLinks } from './service-icon-links'
import { AlbumHeaderPlay } from './detail-play'
import { DetailMore } from './detail-more'
import { useDetailView } from './detail-inspector-context'
import { WatchedToggle } from './watched-button'
import {
  DetailArt,
  DetailTabs,
  FilterPill,
  RatingCards,
  ratingStat,
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

/** The ratings an album overview leads with. Each opens its source page. */
function albumHeadlineRatings(ratings: ProviderRating[]) {
  return ratings.filter((rating) => rating.score !== undefined).slice(0, 2)
}

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
  filterHref,
  selected,
  max,
  sourcesFor,
}: {
  field: string
  values: readonly string[]
  onFilter: OnFilter
  filterHref: BrowseFilterHref
  selected: readonly BrowseFilter[]
  /** Shows this many, then a button for the rest. */
  max?: number
  sourcesFor?: Pick<AlbumDetail | FilmDetail, 'id' | 'mediaType' | 'tags'>
}) {
  const view = useDetailView()
  const more = `${field}:${values[0] ?? ''}`
  const [all, setAll] = useState(
    view.params.get('moreValues') === more ||
      values
        .slice(max)
        .some((value) => view.params.get('tagSources') === `${field}:${value}`),
  )
  const expanded = new URLSearchParams(view.params)
  expanded.set('moreValues', more)
  const shown = max === undefined || all ? values : values.slice(0, max)
  const hidden = values.length - shown.length
  return (
    <span className="ds-pills" data-wrap="">
      {shown.map((value) => {
        const active = selected.find((filter) =>
          sameBrowseFilter(filter, { field, value }),
        )
        const label = formatBrowseFilterValue(field, value)
        const tagId = sourcesFor?.tags.find((tag) =>
          sameBrowseFilter({ field, value: tag.name }, { field, value }),
        )?.id
        return (
          <FilterPill
            key={value}
            label={label}
            mode={active ? (active.mode ?? 'any') : undefined}
            title={`Filter ${field}: ${label}. Shift-click to keep details open.`}
            onClick={(event) => onFilter({ field, value }, event.shiftKey)}
            workspaceHref={
              sourcesFor && tagId
                ? detailPageHref({
                    kind: 'tag',
                    id: tagDetailId(sourcesFor.mediaType, tagId),
                  })
                : filterHref({ field, value })
            }
            action={
              sourcesFor && (
                <MetadataSourceControl
                  field={field}
                  name={value}
                  resource={{ kind: sourcesFor.mediaType, id: sourcesFor.id }}
                  tagId={tagId ?? undefined}
                />
              )
            }
          />
        )
      })}
      {hidden > 0 && (
        <Button
          {...workspaceTabLinkProps(
            view.workspaceHref(expanded),
            `+${formatCount(hidden)} more`,
          )}
          variant="link"
          size="xs"
          onClick={() => setAll(true)}
        >
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
  const view = useDetailView()
  const [open, setOpen] = useState(view.params.get('fieldsExpanded') === 'true')
  const expanded = new URLSearchParams(view.params)
  expanded.set('fieldsExpanded', 'true')
  return (
    <Section
      title="Details"
      aside={
        <Button
          {...workspaceTabLinkProps(view.workspaceHref(expanded), 'All fields')}
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
      {open && (
        <FieldProvenance
          mediaItemId={mediaItemId}
          focusedField={view.params.get('provenanceField')}
        />
      )}
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
  filterHref: workspaceFilterHref,
  onFiltersChange,
  highlightField,
  browseMetric,
}: {
  mediaType: 'album' | 'film'
  id: string
  onFilter?: OnFilter
  filterHref?: BrowseFilterHref
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
  const { tab, setTab, tabHref } = mediaType === 'album' ? albumTab : filmTab
  const view = useDetailView()
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
  function filtersWith(value: BrowseFilter) {
    return selectedFilters.some((item) => sameBrowseFilter(item, value))
      ? selectedFilters
      : [...selectedFilters, value]
  }
  function browseDestination(filters: BrowseFilter[]) {
    const params = new URLSearchParams(browseParams)
    for (const key of [
      'tab',
      'tagSources',
      'fieldsExpanded',
      'provenanceField',
      'sourceProvider',
      'sourceMode',
      'sourceSnapshot',
      'albumTrackView',
      'moreValues',
    ])
      params.delete(key)
    return browseFilterHref(`/${collection}?${params}`, filters)
  }
  function filterHref(value: BrowseFilter) {
    return workspaceFilterHref?.(value) ?? browseDestination(filtersWith(value))
  }
  function filter(value: BrowseFilter, keepOpen = false) {
    if (onFilter) {
      onFilter(value, keepOpen)
      return
    }
    if (!keepOpen) {
      window.location.assign(filterHref(value))
      return
    }
    const params = new URLSearchParams(window.location.search)
    params.set('filters', JSON.stringify(filtersWith(value)))
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}?${params}`,
    )
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
  function ratingHref(rating: ProviderRating) {
    const params = new URLSearchParams(view.params)
    params.delete('tab')
    params.delete('tagSources')
    params.set('fieldsExpanded', 'true')
    params.set('provenanceField', rating.key)
    return view.workspaceHref(params)
  }
  function metadataValue(field: string, value: string) {
    return (
      <span
        {...workspaceTabLinkProps(filterHref({ field, value }), value)}
        tabIndex={0}
      >
        {value}
      </span>
    )
  }
  function metadataValues(field: string) {
    const entries = textValues(field)
    return entries.length > 0
      ? entries.map((value, index) => (
          <Fragment key={value}>
            {index > 0 && ', '}
            {metadataValue(field, value)}
          </Fragment>
        ))
      : EMPTY_VALUE
  }
  useDetailPerformance(mediaType === 'album' ? 'albums' : undefined, id, detail)
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
    item.mediaType === 'album' ? albumHeadlineRatings : undefined,
  )
  const links = serviceLinks(providers.links)
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
  const [country] = textValues('country')

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
              fallbackHref={(value) =>
                filterHref({
                  field: item.mediaType === 'album' ? 'artist' : 'director',
                  value,
                })
              }
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
        item.mediaType === 'film' && country
          ? metadataValue('country', country)
          : null,
        needsId ? (
          <span
            {...workspaceTabLinkProps(tabHref('sources'), 'Needs ID')}
            tabIndex={0}
          >
            <Status state="attention">Needs ID</Status>
          </span>
        ) : null,
      ]}
      play={
        item.mediaType === 'album' && (
          <AlbumHeaderPlay
            album={item}
            source={() =>
              createAlbumPlaybackSource(
                item,
                `${window.location.pathname}${window.location.search}`,
              )
            }
          />
        )
      }
      links={
        links.length > 0 && (
          <ServiceIconLinks links={links} itemTitle={item.title} />
        )
      }
      actions={
        <>
          {item.mediaType === 'film' && <WatchedButton item={item} />}
          {needsId && (
            <Button
              {...workspaceTabLinkProps(tabHref('sources'), 'Identify film')}
              size="md"
              onClick={() => setTab('sources')}
            >
              Identify film
            </Button>
          )}
          <DetailActionsSpacer />
          <DetailMore
            crumb={{ title: item.title }}
            items={[
              {
                label: 'Edit',
                workspaceHref: tabHref('edit'),
                onSelect: () => setTab('edit'),
              },
            ]}
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
          filterHref={filterHref}
          selected={selectedFilters}
          sourcesFor={item}
        />
      </Section>
    ))
  }

  let overview: ReactNode
  if (item.mediaType === 'album') {
    const ratings = albumHeadlineRatings(providers.ratings)
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
      ...ratings.map((rating) => ratingStat(rating, ratingHref(rating))),
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
              filterHref={filterHref}
              selected={selectedFilters}
            />
          ) : (
            EMPTY_VALUE
          ),
        },
        {
          key: 'country',
          label: 'Country',
          value: metadataValues('country'),
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
      ['scrobbles', 'lastListenedAt', ...ratings.map((rating) => rating.key)],
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
          {item.playlists.some(({ kind }) => kind === 'collection') && (
            <Section title="Collections">
              <CollectionLinks
                mediaType="album"
                item={item}
                activeFilters={selectedFilters}
                filterHref={filterHref}
                pills
              />
            </Section>
          )}
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
          value: metadataValues('country'),
        },
        {
          key: 'language',
          label: 'Language',
          value: metadataValues('language'),
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
          value: metadataValue('watched', item.watched ? 'Yes' : 'No'),
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
              <RatingCards
                ratings={providers.ratings}
                ratingHref={ratingHref}
              />
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
                  value: (
                    <CastPills
                      credits={group.credits}
                      max={group.max}
                      fallbackHref={(value) =>
                        filterHref({ field: group.role, value })
                      }
                    />
                  ),
                }))}
              />
            </Section>
          )}
        </div>
        <div className="dtl-side">
          {tagSection([
            { label: 'Genres', field: 'genre', values: genres },
            {
              label: 'Keywords',
              field: 'genre',
              values: keywords,
              max: 6,
            },
          ])}
          <DetailsSection mediaItemId={item.id} facts={facts} />
          {collections.length > 0 && (
            <Section title="Collections">
              <CollectionLinks
                mediaType="film"
                item={item}
                activeFilters={selectedFilters}
                filterHref={filterHref}
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
            <Link href={browseDestination(selectedFilters)}>
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
            filterHref={(filter) => browseDestination([filter])}
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
  fallbackHref,
}: {
  credits: FilmDetail['credits']
  max?: number
  fallbackHref: (value: string) => string
}) {
  const [all, setAll] = useState(false)
  const shown = max === undefined || all ? credits : credits.slice(0, max)
  const hidden = credits.length - shown.length
  return (
    <span className="dtl-pillrow">
      <CreatorLinks
        creators={shown}
        kind="person"
        pills
        fallbackHref={fallbackHref}
      />
      {hidden > 0 && (
        <Button variant="link" size="xs" onClick={() => setAll(true)}>
          +{formatCount(hidden)} more
        </Button>
      )}
    </span>
  )
}
