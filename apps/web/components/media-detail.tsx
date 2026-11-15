'use client'
import { CreatorLinks } from './creator-links'
import { musicDisplayTags } from '@repo/schemas/music-tags'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import {
  AlbumDetailSchema,
  FilmDetailSchema,
  AlbumPatchSchema,
  FilmPatchSchema,
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
} from '@repo/schemas/browse'
import { Button } from '@repo/ui/components/ui/button'
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@repo/ui/components/ui/tabs'
import { Input } from '@repo/ui/components/ui/input'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { invalidateMediaItem } from '@/utils/query-cache'
import MediaArtwork from './media-artwork'
import MediaSources, { MediaEditHistory } from './media-sources'
import { FilterButton, FilterIndicator } from './filter-affordance'
import { BrowseFilterChips, filterModeClass } from './browse-controls'
import { parseAlbumBrowseFiltersParam } from '@repo/schemas/media'
import DetailProviderLinks from './detail-provider-links'
import { AlbumSpotifyLink } from './service-icon-links'
import { useDetailView } from './detail-inspector-context'
import { withoutDetailEntries } from '@/utils/detail-inspector'
import { AlbumPlayButtons } from './play-controls'
import {
  albumDetailTab,
  albumTrackView,
  createAlbumPlaybackSource,
} from '@/utils/playback-source'
import AlbumTracksTable from './album-tracks-table'
import { scopedHref } from '@/utils/media-scope'
import MetadataSourceControl from './metadata-source-control'
import { FilmCollectionLinks } from './film-collection-links'
import AlbumListening from './album-listening'
import AlbumPlaylists from './album-playlists'
import type { SourceNavigationLink } from '@repo/schemas/tags'

const DetailSchema = z.union([AlbumDetailSchema, FilmDetailSchema])

function FilterBadge({
  field,
  value,
  label = value,
  onFilter,
}: {
  field: string
  value: string
  label?: string
  onFilter: (filter: BrowseFilter, keepOpen?: boolean) => void
}) {
  const params = useSearchParams()
  const active = parseAlbumBrowseFiltersParam(params.get('filters')).find(
    (filter) => sameBrowseFilter(filter, { field, value }),
  )
  return (
    <FilterButton
      className={`metadata-tag ${active ? filterModeClass(active.mode) : ''}`}
      title={`Filter ${field}: ${value}. Shift-click to keep details open.`}
      onClick={(event) => onFilter({ field, value }, event.shiftKey)}
    >
      {label}
    </FilterButton>
  )
}

function FilterValues({
  field,
  values,
  onFilter,
  mediaId,
  collectionSources,
}: {
  field: string
  values: string[]
  onFilter: (filter: BrowseFilter, keepOpen?: boolean) => void
  mediaId?: string
  collectionSources?: SourceNavigationLink[]
}) {
  return (
    <div className="detail-tags detail-tags-scroll">
      {values.map((value) => (
        <span key={value} className="inline-flex items-center">
          <FilterBadge field={field} value={value} onFilter={onFilter} />
          {mediaId && (
            <MetadataSourceControl
              field={field}
              name={value}
              mediaId={mediaId}
              collectionSources={collectionSources}
            />
          )}
        </span>
      ))}
    </div>
  )
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
      className="media-edit"
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
      <div className="edit-grid">
        {fields.map((field) => {
          const raw = baseline[field.key]
          const value =
            raw === null || raw === undefined
              ? ''
              : field.type === 'date' && typeof raw === 'string'
                ? raw.slice(0, 10)
                : String(raw)
          return (
            <label key={field.key}>
              {field.label}
              <Input
                name={field.key}
                type={field.type}
                required={field.key === 'title'}
                min={field.type === 'number' ? 0 : undefined}
                defaultValue={value}
              />
            </label>
          )
        })}
      </div>
      {item.mediaType === 'album' && (
        <p className="quiet text-sm">
          An earlier first Last.fm scrobble is used for Added in the library.
          The stored date is kept.
        </p>
      )}
      <label>
        Summary
        <textarea name="summary" defaultValue={item.summary ?? ''} rows={3} />
      </label>
      {item.mediaType === 'film' && (
        <label className="check-label">
          <input type="checkbox" name="watched" defaultChecked={item.watched} />{' '}
          Watched
        </label>
      )}
      <label>
        Note
        <Input name="note" />
      </label>
      <div className="form-actions">
        <Button disabled={mutation.isPending} type="submit">
          {mutation.isPending ? 'Saving...' : 'Save changes'}
        </Button>
        <span role="status">{mutation.isSuccess ? 'Saved' : error}</span>
        {mutation.isError && (
          <span role="alert">Could not save. Check the values and retry.</span>
        )}
      </div>
    </form>
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
  onFilter?: (filter: BrowseFilter, keepOpen?: boolean) => void
  onFiltersChange?: (filters: BrowseFilter[]) => void
  /** Browse sort field, pinned first among the metrics. */
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
  const view = useDetailView()
  const activeTab = view.params.get('tab')
  const tab =
    mediaType === 'album'
      ? albumDetailTab(view.params, id)
      : activeTab === 'sources' || activeTab === 'history'
        ? 'sources'
        : activeTab === 'edit'
          ? 'edit'
          : 'overview'
  function setTab(next: string) {
    if (mediaType === 'album')
      view.params.set(
        'albumTrackView',
        JSON.stringify(albumTrackView(view.params.get('albumTrackView'), id)),
      )
    if (next === 'overview') view.params.delete('tab')
    else view.params.set('tab', next)
    view.replace(view.params)
  }
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
  if (detail.isPending) return <p className="browse-empty">Loading...</p>
  if (!detail.data)
    return (
      <p role="alert">
        Could not load this item.{' '}
        <Button onClick={() => detail.refetch()}>Retry</Button>
      </p>
    )
  const item = detail.data
  const fallbackArtistTags = musicDisplayTags(
    item.tags.map((tag) => tag.name),
    item.mediaType === 'album' ? item.artistTags : [],
  )
    .filter((tag) => tag.source === 'artist')
    .map((tag) => tag.name)
  const values = {
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
  const creatorField = mediaType === 'album' ? 'artist' : 'director'
  return (
    <div className="media-detail">
      <header className="detail-heading">
        <MediaArtwork
          src={item.artworkUrl}
          alt={item.title}
          fallbackLabel="No artwork"
          containerClassName="detail-art"
          imageClassName={
            mediaType === 'album'
              ? 'aspect-square object-cover w-full'
              : 'aspect-[2/3] object-cover w-full'
          }
          fallbackClassName={
            mediaType === 'album' ? 'aspect-square' : 'aspect-[2/3]'
          }
        />
        <div>
          <h1>
            {item.title}
            {item.mediaType === 'album' && (
              <>
                {' '}
                <AlbumSpotifyLink item={item} />
              </>
            )}
          </h1>
          {item.mediaType === 'film' &&
            filmIdentificationStatus(item.providerReferences) ===
              'Needs ID' && (
              <button className="needs-id" onClick={() => setTab('edit')}>
                Needs ID · Identify film
              </button>
            )}
          {item.originalTitle && item.originalTitle !== item.title && (
            <p className="quiet">{item.originalTitle}</p>
          )}
          <CreatorLinks
            creators={item.credits.filter(
              (credit) => credit.role === creatorField,
            )}
            kind={mediaType === 'album' ? 'artist' : 'person'}
            pills
          />
          <div className="detail-facts">
            <span>{item.releaseDate?.slice(0, 10)}</span>
            <span>
              {item.mediaType === 'album'
                ? item.durationSec !== null
                  ? `${Math.round(item.durationSec / 60)} min`
                  : ''
                : item.runtimeMinutes
                  ? `${item.runtimeMinutes} min`
                  : ''}
            </span>
            {typeof values.source === 'string' && values.source && (
              <FilterBadge
                field="source"
                value={values.source}
                onFilter={filter}
              />
            )}
            {item.mediaType === 'film' && (
              <FilterBadge
                field="watched"
                value={item.watched ? 'Yes' : 'No'}
                label={item.watched ? 'Watched' : 'Unwatched'}
                onFilter={filter}
              />
            )}
          </div>
          <DetailProviderLinks
            hideSpotify={item.mediaType === 'album'}
            references={item.providerReferences}
            fields={browseFields}
            values={values}
            links={item.links}
            spotifyUrl={
              item.mediaType === 'album' ? item.spotifyUrl : undefined
            }
          />
          {item.mediaType === 'album' && (
            <AlbumPlayButtons
              album={item}
              source={() =>
                createAlbumPlaybackSource(
                  item,
                  `${window.location.pathname}${window.location.search}`,
                )
              }
            />
          )}
        </div>
      </header>
      {selectedFilters.length > 0 && (
        <div className="detail-filter-selection">
          <Link href={`/${collection}?${browseParams}`}>
            <FilterIndicator />
            Browse with {selectedFilters.length} filters
          </Link>
          <BrowseFilterChips
            filters={selectedFilters}
            fields={fields.data ?? []}
            onChange={changeFilters}
          />
        </div>
      )}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          {item.mediaType === 'album' && (
            <TabsTrigger value="playlists">Playlists</TabsTrigger>
          )}
          {item.mediaType === 'album' && (
            <TabsTrigger value="tracks">
              Tracks ({item.tracks.length})
            </TabsTrigger>
          )}
          {item.mediaType === 'album' && (
            <TabsTrigger value="listening">Listening</TabsTrigger>
          )}
          <TabsTrigger value="sources">Sources</TabsTrigger>
          <TabsTrigger value="edit">Edit</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          {item.summary && <p className="detail-summary">{item.summary}</p>}
          <dl className="detail-metrics">
            {browseFields
              .filter((field) => field.type !== 'text' && !field.rating)
              .map((field) => {
                const value = values[field.key]
                return value === undefined || value === null ? null : (
                  <div
                    key={field.key}
                    data-sorted={field.key === highlightField || undefined}
                  >
                    <dt>{field.label}</dt>
                    <dd>
                      {formatBrowseValue(field, value)}
                      {field.key === 'dateAdded' && item.dateAddedSource && (
                        <small className="quiet block">
                          {item.dateAddedSource}
                        </small>
                      )}
                    </dd>
                  </div>
                )
              })}
          </dl>
          <div className="detail-metadata">
            {fields.data
              ?.filter(
                (field) =>
                  field.type === 'text' &&
                  ![
                    'title',
                    'summary',
                    creatorField,
                    'source',
                    'watched',
                    'provider',
                    'keyword',
                    'albumTag',
                    'artistTag',
                    // Albums list their playlists below, with the add control.
                    ...(item.mediaType === 'album' ? ['playlist'] : []),
                  ].includes(field.key),
              )
              .map((field) => {
                const value = values[field.key]
                if (
                  value === undefined ||
                  value === null ||
                  (Array.isArray(value) && value.length === 0)
                )
                  return null
                return (
                  <section key={field.key}>
                    <h2>
                      {field.label}
                      {field.key === 'genre' && (
                        <Link
                          className="ml-3 text-xs font-normal underline"
                          href={scopedHref('/tags', item.mediaType)}
                        >
                          Manage tags
                        </Link>
                      )}
                    </h2>
                    {['actor', 'director'].includes(field.key) ? (
                      <CreatorLinks
                        creators={item.credits.filter(
                          (credit) => credit.role === field.key,
                        )}
                        kind="person"
                        pills
                      />
                    ) : field.key === 'genre' && item.mediaType === 'album' ? (
                      <>
                        <FilterValues
                          field="genre"
                          mediaId={item.id}
                          values={item.tags.map((tag) => tag.name)}
                          onFilter={filter}
                        />
                        {fallbackArtistTags.length > 0 && (
                          <div className="mt-2">
                            <p className="quiet mb-1">Artist tags</p>
                            <FilterValues
                              field="artistTag"
                              values={fallbackArtistTags}
                              onFilter={filter}
                            />
                          </div>
                        )}
                      </>
                    ) : field.key === 'collection' &&
                      item.mediaType === 'film' ? (
                      <FilmCollectionLinks
                        item={item}
                        activeFilters={selectedFilters}
                        pills
                      />
                    ) : field.filterable ? (
                      <FilterValues
                        field={field.key}
                        mediaId={item.id}
                        collectionSources={item.collectionSources}
                        values={Array.isArray(value) ? value : [String(value)]}
                        onFilter={filter}
                      />
                    ) : (
                      <p>{String(value)}</p>
                    )}
                  </section>
                )
              })}
          </div>
        </TabsContent>
        {item.mediaType === 'album' && (
          <TabsContent value="playlists">
            <AlbumPlaylists key={item.id} albumId={item.id} />
          </TabsContent>
        )}
        {item.mediaType === 'album' && (
          <TabsContent value="tracks">
            <AlbumTracksTable album={item} />
          </TabsContent>
        )}
        {item.mediaType === 'album' && (
          <TabsContent value="listening">
            <AlbumListening key={item.id} albumId={item.id} />
          </TabsContent>
        )}
        <TabsContent value="edit" onInputCapture={() => setSaved(false)}>
          <EditMedia key={item.updatedAt} item={item} onSaved={onSaved} />
          {saved && <p role="status">Changes saved.</p>}
          <MediaEditHistory id={item.id} />
        </TabsContent>
        <TabsContent value="sources">
          <MediaSources
            key={item.id}
            item={item}
            onSaved={async () => {
              await invalidateMediaItem(queryClient, mediaType, id)
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
