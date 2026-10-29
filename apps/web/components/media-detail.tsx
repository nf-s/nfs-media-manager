'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import {
  AlbumDetailSchema,
  FilmDetailSchema,
  AlbumPatchSchema,
  FilmPatchSchema,
  MediaHistorySchema,
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
  type BrowseFilter,
} from '@repo/schemas/browse'
import { ProviderSummarySchema } from '@repo/schemas/provider'
import { JobSchema } from '@repo/schemas/job'
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
import MediaArtwork from './media-artwork'
import MediaHistoryList from './media-history-list'
import ProviderIdentifiers from './provider-identifiers'
import ExternalLink from './external-link'
import { FilterButton, FilterIndicator } from './filter-affordance'
import { BrowseFilterChips, filterModeClass } from './browse-controls'
import { parseAlbumBrowseFiltersParam } from '@repo/schemas/media'
import DetailProviderLinks from './detail-provider-links'
import AlbumTitle from './album-title'
import AlbumProviderDetails from './album-provider-details'
import { albumSpotifyDestination } from '@/utils/album-links'
import { scopedHref } from '@/utils/media-scope'
import MetadataSourceControl from './metadata-source-control'
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
  const [all, setAll] = useState(false)
  return (
    <div className="detail-tags">
      {(all ? values : values.slice(0, 12)).map((value) => (
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
      {values.length > 12 && (
        <button className="quiet" onClick={() => setAll(!all)}>
          {all ? 'Less' : `+${values.length - 12} more`}
        </button>
      )}
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
  const fields = [
    { key: 'title', label: 'Title', type: 'text' },
    { key: 'originalTitle', label: 'Original title', type: 'text' },
    { key: 'artworkUrl', label: 'Artwork URL', type: 'url' },
    { key: 'sourceLabel', label: 'Source', type: 'text' },
    { key: 'releaseDate', label: 'Release date', type: 'date' },
    { key: 'dateAdded', label: 'Date added', type: 'date' },
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
}: {
  mediaType: 'album' | 'film'
  id: string
  onFilter?: (filter: BrowseFilter, keepOpen?: boolean) => void
  onFiltersChange?: (filters: BrowseFilter[]) => void
}) {
  const { apiBaseUrl } = useConfig()
  const searchParams = useSearchParams()
  const selectedFilters = parseAlbumBrowseFiltersParam(
    searchParams.get('filters'),
  )
  const browseParams = new URLSearchParams(searchParams)
  browseParams.delete('item')
  const queryClient = useQueryClient()
  const [tab, setTab] = useState('overview')
  const [provider, setProvider] = useState('')
  const [saved, setSaved] = useState(false)
  const collection = mediaType === 'album' ? 'albums' : 'films'
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
  const history = useQuery({
    queryKey: ['history', id],
    enabled: tab === 'history',
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/media/${id}/history`,
        MediaHistorySchema,
      ),
  })
  const providers = useQuery({
    queryKey: ['providers'],
    enabled: tab === 'edit',
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/providers',
        z.array(ProviderSummarySchema),
      ),
  })
  const rescrape = useMutation({
    mutationFn: () =>
      fetchApiData(apiBaseUrl, `/api/v1/media/${id}/rescrape`, JobSchema, {
        method: 'POST',
        body: JSON.stringify({ provider }),
      }),
  })
  async function onSaved() {
    await queryClient.invalidateQueries({ queryKey: [mediaType, id] })
    await queryClient.invalidateQueries({ queryKey: [collection] })
    await queryClient.invalidateQueries({ queryKey: ['history', id] })
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
    const params = new URLSearchParams(window.location.search)
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
  const values = getBrowseValues(item)
  const browseFields =
    fields.data ??
    (mediaType === 'album' ? albumBrowseFields : filmBrowseFields)
  const creatorField = mediaType === 'album' ? 'artist' : 'director'
  const creators = values[creatorField]
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
            {item.mediaType === 'album' ? (
              <AlbumTitle item={item} />
            ) : (
              item.title
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
          {Array.isArray(creators) && (
            <FilterValues
              field={creatorField}
              values={creators}
              onFilter={filter}
            />
          )}
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
            hideSpotify={
              item.mediaType === 'album' &&
              Boolean(albumSpotifyDestination(item))
            }
            references={item.providerReferences}
            fields={browseFields}
            values={values}
            links={item.links}
            spotifyUrl={
              item.mediaType === 'album' ? item.spotifyUrl : undefined
            }
          />
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
            <TabsTrigger value="tracks">
              Tracks ({item.tracks.length})
            </TabsTrigger>
          )}
          <TabsTrigger value="edit">Edit</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          {item.summary && <p className="detail-summary">{item.summary}</p>}
          {item.mediaType === 'film' &&
            item.metadata?.nfo &&
            typeof item.metadata.nfo === 'object' &&
            !Array.isArray(item.metadata.nfo) &&
            typeof item.metadata.nfo.path === 'string' && (
              <dl className="my-3 text-sm">
                <dt className="quiet">NFO file</dt>
                <dd className="break-all select-text font-mono text-xs">
                  {item.metadata.nfo.path}
                </dd>
              </dl>
            )}
          <dl className="detail-metrics">
            {browseFields
              .filter((field) => field.type !== 'text' && !field.rating)
              .map((field) => {
                const value = values[field.key]
                return value === undefined || value === null ? null : (
                  <div key={field.key}>
                    <dt>{field.label}</dt>
                    <dd>
                      {formatBrowseValue(field, value)}
                      {field.key === 'dateAdded' &&
                        item.mediaType === 'film' && (
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
                    {field.filterable ? (
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
          {item.mediaType === 'album' && (
            <AlbumProviderDetails details={item.providerDetails ?? []} />
          )}
        </TabsContent>
        {item.mediaType === 'album' && (
          <TabsContent value="tracks">
            <table className="track-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Track</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {item.tracks.map((track) => (
                  <tr key={track.position}>
                    <td>{track.position}</td>
                    <td>
                      {track.externalId ? (
                        <ExternalLink
                          href={`https://open.spotify.com/track/${encodeURIComponent(track.externalId)}`}
                        >
                          {track.title}
                        </ExternalLink>
                      ) : (
                        track.title
                      )}
                    </td>
                    <td>
                      {track.durationSec === null
                        ? '-'
                        : `${Math.floor(track.durationSec / 60)}:${String(track.durationSec % 60).padStart(2, '0')}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!item.tracks.length && (
              <p className="quiet">No imported tracks.</p>
            )}
          </TabsContent>
        )}
        <TabsContent value="edit" onInputCapture={() => setSaved(false)}>
          <ProviderIdentifiers item={item} onSaved={onSaved} />
          <EditMedia key={item.updatedAt} item={item} onSaved={onSaved} />
          {saved && <p role="status">Changes saved.</p>}
          <div className="rescrape-row">
            <select
              aria-label="Rescrape provider"
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
            >
              <option value="">Choose provider</option>
              {providers.data
                ?.filter(
                  (provider) =>
                    provider.supportsScrape &&
                    provider.mediaTypes.includes(mediaType),
                )
                .map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.displayName}
                  </option>
                ))}
            </select>
            <Button
              variant="outline"
              disabled={!provider || rescrape.isPending}
              onClick={() => rescrape.mutate()}
            >
              Re-scrape this item
            </Button>
            {rescrape.data && (
              <Link href={`/jobs?jobId=${rescrape.data.id}`}>View job</Link>
            )}
            {rescrape.isError && <p role="alert">{rescrape.error.message}</p>}
          </div>
        </TabsContent>
        <TabsContent value="history">
          {history.isPending ? (
            <p>Loading history...</p>
          ) : history.isError ? (
            <p role="alert">
              History unavailable.{' '}
              <Button onClick={() => history.refetch()}>Retry</Button>
            </p>
          ) : (
            <MediaHistoryList history={history.data} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
