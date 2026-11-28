'use client'

import { useState } from 'react'
import { Filter } from 'lucide-react'
import { LibraryPlaylistTypeSchema } from '@repo/schemas/browse'
import {
  PlaylistBrowseQuerySchema,
  PlaylistSourceSchema,
  PlaylistSyncScheduleSchema,
  type PlaylistBrowseSort,
  type PlaylistColumnRanges,
} from '@repo/schemas/tracks'
import { Select } from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import type { BrowseHost } from '@/hooks/useBrowseHost'
import type { LibraryPlaylistLibrary } from '@repo/schemas/library-playlists'
import { useKeyNotation } from '@/utils/key-notation'
import { listsImportedPlaylists } from '@/utils/library-playlists'
import { playlistSourceLabel } from '@/utils/playlist-sync'
import { youtubeScheduleLabels } from '@/utils/youtube'
import { BrowseFilterPill } from './browse-controls'
import { FilterPanelSection } from './browse-filter-panel'
import { ColumnFilterOptions, SecondaryHeaderFilter } from './secondary-table'

type FilterColumn = { key: PlaylistBrowseSort | 'savedView'; label: string }

const filterSchema = PlaylistBrowseQuerySchema.pick({
  name: true,
  owner: true,
  description: true,
  types: true,
  sources: true,
  savedView: true,
  savedViewText: true,
  schedules: true,
  columnRanges: true,
})

const typeLabel = (value: 'playlist' | 'smart') =>
  value === 'smart' ? 'Smart playlist' : 'Playlist'
const sourceLabel = (value: 'library' | 'spotify' | 'spotify-liked') =>
  playlistSourceLabel(value === 'library' ? null : value)

const dayFields = new Set<keyof PlaylistColumnRanges>([
  'updated',
  'added',
  'checked',
  'imported',
  'nextSync',
])

/** Use the same validated URL filters for the count, pages and controls. */
export function usePlaylistDirectoryFilters(
  host: BrowseHost,
  library: LibraryPlaylistLibrary,
) {
  const notation = useKeyNotation()
  const filters =
    filterSchema.safeParse(Object.fromEntries(host.params)).data ?? {}
  if (!listsImportedPlaylists(library)) {
    delete filters.owner
    delete filters.description
    delete filters.schedules
    if (filters.columnRanges) {
      const { count, updated } = filters.columnRanges
      filters.columnRanges = count || updated ? { count, updated } : undefined
    }
  }
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined)
      params[key] = typeof value === 'string' ? value : JSON.stringify(value)
  }
  if (
    (library === 'tracks' && filters.savedViewText) ||
    [...dayFields].some((key) => filters.columnRanges?.[key])
  )
    params.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (library === 'tracks' && filters.savedViewText)
    params.keyNotation = notation

  function update(changes: Record<string, string | undefined>) {
    host.update((url) => {
      for (const [key, value] of Object.entries(changes)) {
        if (value) url.set(key, value)
        else url.delete(key)
      }
    })
  }

  function range(
    key: keyof PlaylistColumnRanges,
    value?: { min?: number | string; max?: number | string },
  ) {
    const next = { ...filters.columnRanges, [key]: value }
    const json = JSON.stringify(next)
    update({ columnRanges: json === '{}' ? undefined : json })
  }

  function summary(key: FilterColumn['key']) {
    switch (key) {
      case 'type':
        return filters.types?.map(typeLabel).join(', ')
      case 'source':
        return filters.sources?.map(sourceLabel).join(', ')
      case 'schedule':
        return filters.schedules
          ?.map((value) => youtubeScheduleLabels[value])
          .join(', ')
      case 'savedView':
        return [
          filters.savedView === 'present'
            ? 'Has saved view'
            : filters.savedView === 'absent'
              ? 'No saved view'
              : '',
          filters.savedViewText,
        ]
          .filter(Boolean)
          .join(' · ')
      case 'name':
      case 'owner':
      case 'description':
        return filters[key]
      default: {
        const bounds = filters.columnRanges?.[key]
        if (!bounds || (bounds.min === undefined && bounds.max === undefined))
          return
        const unit = key === 'duration' ? ' min' : ''
        if (bounds.min === undefined) return `≤ ${bounds.max}${unit}`
        if (bounds.max === undefined) return `≥ ${bounds.min}${unit}`
        return `${bounds.min} – ${bounds.max}${unit}`
      }
    }
  }

  function clear(key: FilterColumn['key']) {
    switch (key) {
      case 'type':
        return update({ types: undefined })
      case 'source':
        return update({ sources: undefined })
      case 'schedule':
        return update({ schedules: undefined })
      case 'savedView':
        return update({ savedView: undefined, savedViewText: undefined })
      case 'name':
      case 'owner':
      case 'description':
        return update({ [key]: undefined })
      default:
        return range(key)
    }
  }
  return { filters, params, update, range, summary, clear }
}

type DirectoryFilters = ReturnType<typeof usePlaylistDirectoryFilters>

function TextFilter({
  label,
  value,
  onApply,
}: {
  label: string
  value?: string
  onApply: (value: string) => void
}) {
  return (
    <form
      key={value ?? ''}
      className="browse-form"
      onSubmit={(event) => {
        event.preventDefault()
        const text = new FormData(event.currentTarget).get('text')
        if (typeof text === 'string') onApply(text.trim())
      }}
    >
      <label className="ds-field">
        <span className="ds-label">{label}</span>
        <Input
          name="text"
          type="search"
          maxLength={200}
          defaultValue={value ?? ''}
        />
      </label>
      <div>
        <Button type="submit">Apply</Button>
      </div>
    </form>
  )
}

function RangeFilter({
  column,
  label,
  state,
}: {
  column: keyof PlaylistColumnRanges
  label: string
  state: DirectoryFilters
}) {
  const bounds = state.filters.columnRanges?.[column]
  const isDate = dayFields.has(column)
  const [error, setError] = useState(false)
  return (
    <form
      className="browse-form"
      key={JSON.stringify(bounds)}
      onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        function bound(key: string) {
          const value = data.get(key)
          if (typeof value !== 'string' || !value) return undefined
          return isDate ? value : Number(value)
        }
        const min = bound('min')
        const max = bound('max')
        if (min !== undefined && max !== undefined && min > max) {
          setError(true)
          return
        }
        setError(false)
        state.range(
          column,
          min === undefined && max === undefined ? undefined : { min, max },
        )
      }}
    >
      <div className="browse-form-pair">
        {(['min', 'max'] as const).map((edge) => (
          <label key={edge} className="ds-field">
            <span className="ds-label">
              {edge === 'min' ? 'Minimum' : 'Maximum'}
              {column === 'duration' ? ' (minutes)' : ''}
            </span>
            <Input
              name={edge}
              aria-label={`${label} ${edge === 'min' ? 'minimum' : 'maximum'}`}
              type={isDate ? 'date' : 'number'}
              min={isDate ? undefined : 0}
              step={column === 'duration' ? 'any' : undefined}
              defaultValue={bounds?.[edge] ?? ''}
            />
          </label>
        ))}
      </div>
      {error && (
        <p role="alert" className="browse-form-error">
          Minimum must not exceed maximum.
        </p>
      )}
      <div>
        <Button type="submit">Apply range</Button>
      </div>
    </form>
  )
}

type ControlProps = {
  column: FilterColumn
  state: DirectoryFilters
  imports: boolean
}

function FilterControls({ column, state, imports }: ControlProps) {
  const { key, label } = column
  const { filters, update } = state
  const list = (name: string, values: string[]) =>
    update({
      [name]: values.length ? JSON.stringify(values.sort()) : undefined,
    })
  switch (key) {
    case 'type':
      return (
        <ColumnFilterOptions
          label={label}
          options={LibraryPlaylistTypeSchema.options.map((value) => ({
            value,
            label: typeLabel(value),
          }))}
          value={filters.types ?? []}
          onChange={(next) => list('types', next)}
        />
      )
    case 'source':
      return (
        <ColumnFilterOptions
          label={label}
          options={[
            { value: 'library', label: 'Library' },
            ...(imports
              ? PlaylistSourceSchema.options.map((value) => ({
                  value,
                  label: sourceLabel(value),
                }))
              : []),
          ]}
          value={filters.sources ?? []}
          onChange={(next) => list('sources', next)}
        />
      )
    case 'schedule':
      return (
        <ColumnFilterOptions
          label={label}
          options={PlaylistSyncScheduleSchema.options.map((value) => ({
            value,
            label: youtubeScheduleLabels[value],
          }))}
          value={filters.schedules ?? []}
          onChange={(next) => list('schedules', next)}
        />
      )
    case 'name':
    case 'owner':
    case 'description':
      return (
        <TextFilter
          label={`${label} contains`}
          value={filters[key]}
          onApply={(value) => update({ [key]: value })}
        />
      )
    case 'savedView':
      return (
        <div className="browse-form">
          <label className="ds-field">
            <span className="ds-label">Saved view</span>
            <Select
              value={filters.savedView ?? ''}
              onChange={({ target }) =>
                update({
                  savedView: target.value,
                  ...(target.value === 'absent'
                    ? { savedViewText: undefined }
                    : {}),
                })
              }
            >
              <option value="">Any</option>
              <option value="present">Has saved view</option>
              <option value="absent">No saved view</option>
            </Select>
          </label>
          {filters.savedView !== 'absent' && (
            <TextFilter
              label="Saved view contains"
              value={filters.savedViewText}
              onApply={(value) => update({ savedViewText: value })}
            />
          )}
        </div>
      )
    default:
      return <RangeFilter column={key} label={label} state={state} />
  }
}

export function PlaylistHeaderFilter(props: ControlProps) {
  return (
    <SecondaryHeaderFilter
      label={props.column.label}
      active={Boolean(props.state.summary(props.column.key))}
    >
      <FilterControls {...props} />
    </SecondaryHeaderFilter>
  )
}

export function PlaylistFilterSection({
  columns,
  state,
  imports,
}: {
  columns: FilterColumn[]
  state: DirectoryFilters
  imports: boolean
}) {
  const [selected, setSelected] = useState('type')
  const column = columns.find(({ key }) => key === selected) ?? columns[0]
  if (!column) return null
  return (
    <FilterPanelSection
      title="Playlist filters"
      icon={<Filter className="ds-i" data-size="sm" aria-hidden />}
      defaultOpen
    >
      <div className="browse-form">
        <label className="ds-field">
          <span className="ds-label">Column</span>
          <Select
            value={column.key}
            onChange={({ target }) => setSelected(target.value)}
          >
            {columns.map(({ key, label }) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </Select>
        </label>
        <FilterControls
          key={column.key}
          column={column}
          state={state}
          imports={imports}
        />
      </div>
    </FilterPanelSection>
  )
}

export function PlaylistFilterChips({
  active,
  state,
}: {
  active: FilterColumn[]
  state: DirectoryFilters
}) {
  if (!active.length) return null
  return (
    <div className="ops-chips" role="group" aria-label="Active filters">
      {active.map(({ key, label }) => (
        <BrowseFilterPill
          key={key}
          removeLabel={`Remove ${label} filter`}
          onRemove={() => state.clear(key)}
        >
          {label} · {state.summary(key)}
        </BrowseFilterPill>
      ))}
    </div>
  )
}
