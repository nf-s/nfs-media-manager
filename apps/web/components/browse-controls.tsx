'use client'

import { useState, type ReactNode } from 'react'
import {
  LayoutGrid,
  PanelsTopLeft,
  List as ListIcon,
  SlidersHorizontal,
  Table2,
  X,
} from 'lucide-react'
import {
  Button,
  ButtonFeedbackLabel,
  type ButtonFeedback,
} from '@repo/ui/components/ui/button'
import { Segmented } from '@repo/ui/components/ds/segmented'
import {
  Pill,
  PillLabel,
  Pills,
  type PillMode,
} from '@repo/ui/components/ds/pill'
import { Select } from '@repo/ui/components/ds/toolbar'
import {
  BrowseRangeSchema,
  formatBrowseFilterValue,
  LIBRARY_PLAYLIST_FILTER_FIELD,
  type BrowseField,
  type BrowseRange,
  type BrowseFilter,
} from '@repo/schemas/browse'
import { FilterPanelSection } from './browse-filter-panel'
import { useLibraryPlaylistNames } from './library-playlist-name'
import { libraryPlaylistChipValue } from '@/utils/library-playlists'
import {
  gridDensities,
  type BrowseView,
  type GridDensity,
} from '@/utils/media-grid'
import {
  musicDisplayTags,
  type MusicDisplayTag,
} from '@repo/schemas/music-tags'
import { formatTagName } from '@repo/schemas/tags'
import type { BrowseFilterHref } from '@/utils/browse-items'
import { workspaceTabLinkProps } from '@/utils/workspace-tab-destination'
import { useProviderDisplayName } from '@/hooks/useProviderDisplayName'

const views = [
  {
    value: 'grid',
    label: 'Grid view',
    icon: <LayoutGrid className="ds-i" data-size="sm" aria-hidden />,
  },
  {
    value: 'list',
    label: 'List view',
    icon: <ListIcon className="ds-i" data-size="sm" aria-hidden />,
  },
  {
    value: 'table',
    label: 'Table view',
    icon: <Table2 className="ds-i" data-size="sm" aria-hidden />,
  },
] satisfies Array<{ value: BrowseView; label: string; icon: ReactNode }>

export function BrowseViewSwitch({
  view,
  onChange,
  detail = false,
}: {
  view: BrowseView
  onChange: (view: BrowseView) => void
  /** The middle view shows a recommendation's detail layout. */
  detail?: boolean
}) {
  return (
    <Segmented
      label="Browse views"
      value={view}
      options={detail ? detailViews : views}
      onChange={onChange}
    />
  )
}

const detailViews = views.map((option) =>
  option.value === 'list'
    ? {
        ...option,
        label: 'Detail view',
        icon: <PanelsTopLeft className="ds-i" data-size="sm" aria-hidden />,
      }
    : option,
)

const densityLabels: Record<GridDensity, string> = {
  compact: 'Compact',
  standard: 'Standard',
  roomy: 'Roomy',
}
const densities = gridDensities.map((value) => ({
  value,
  label: densityLabels[value],
}))

/** Card size in the Grid view, the first control under View in the Filters drawer. */
export function BrowseDensitySwitch({
  density,
  onChange,
}: {
  density: GridDensity
  onChange: (density: GridDensity) => void
}) {
  return (
    <Segmented
      label="Grid size"
      value={density}
      options={densities}
      onChange={onChange}
    />
  )
}

/**
 * An item's tags as pills that add a filter. Shows the first `max` and a
 * `+N` count; the pills are never clipped or scrolled. Artist tags shown in
 * place of missing album tags use the outline pill. `storedNames` shows tags
 * from outside the tag library, such as a subscription's, as their source
 * wrote them.
 */
export function BrowseTagBadges({
  field = 'genre',
  tags,
  artistTags,
  trackTags,
  onFilter,
  filterHref,
  className,
  max = 3,
  storedNames = false,
}: {
  field?: string
  tags: string[]
  artistTags?: string[]
  /** A track's own tags, shown before `tags` (TTAG-14). */
  trackTags?: string[]
  onFilter: (filter: BrowseFilter) => void
  filterHref?: BrowseFilterHref
  className?: string
  max?: number
  storedNames?: boolean
}) {
  const shown: MusicDisplayTag[] =
    artistTags === undefined && trackTags === undefined
      ? tags.map((name) => ({
          name,
          source:
            field === 'artistTag'
              ? 'artist'
              : field === 'trackTag'
                ? 'track'
                : 'album',
        }))
      : musicDisplayTags(tags, artistTags ?? [], trackTags)
  if (shown.length === 0) return null
  return (
    <Pills label="Tags" max={max} className={className}>
      {shown.map(({ name: tag, source }) => {
        const label = storedNames ? tag : formatTagName(tag)
        const filter = {
          field:
            source === 'artist'
              ? 'artistTag'
              : source === 'track'
                ? 'trackTag'
                : field,
          value: tag,
        }
        return (
          <Pill
            asChild
            key={tag}
            tone={source === 'artist' ? 'outline' : undefined}
          >
            <button
              {...(filterHref
                ? workspaceTabLinkProps(filterHref(filter), label)
                : undefined)}
              type="button"
              title={`${source === 'artist' ? 'Artist tag' : source === 'track' ? 'Track tag' : 'Tag'}: ${label}`}
              onClick={(event) => {
                event.stopPropagation()
                onFilter(filter)
              }}
            >
              <PillLabel>{label}</PillLabel>
              {source === 'artist' && (
                <span className="sr-only">, artist tag</span>
              )}
            </button>
          </Pill>
        )
      })}
    </Pills>
  )
}

/** The legacy class for a filter mode. Prefer `filterPillMode` with `Pill`. */
export function filterModeClass(mode: BrowseFilter['mode']) {
  return mode === 'required'
    ? 'filter-required'
    : mode === 'exclude'
      ? 'filter-exclude'
      : 'filter-any'
}

/** The `Pill` mode for a filter: any, required or excluded. */
export function filterPillMode(mode: BrowseFilter['mode']): PillMode {
  return mode ?? 'any'
}

/**
 * A removable filter pill. Its label is a button when `onActivate` is set
 * (for example to cycle the mode); the cross removes it.
 */
export function BrowseFilterPill({
  mode,
  children,
  title,
  label,
  onActivate,
  destination,
  onRemove,
  removeLabel,
  removeDisabled,
  removeFeedback,
}: {
  mode?: PillMode
  children: ReactNode
  title?: string
  label?: string
  onActivate?: () => void
  destination?: { href: string; label: string }
  onRemove: () => void
  removeLabel: string
  removeDisabled?: boolean
  removeFeedback?: ButtonFeedback
}) {
  return (
    <Pill mode={mode} asChild>
      <span className="browse-filter-pill">
        {onActivate ? (
          <button
            {...(destination
              ? workspaceTabLinkProps(destination.href, destination.label)
              : undefined)}
            type="button"
            className="browse-pill-action"
            title={title}
            aria-label={label}
            onClick={onActivate}
          >
            <PillLabel>{children}</PillLabel>
          </button>
        ) : destination ? (
          <PillLabel
            {...workspaceTabLinkProps(destination.href, destination.label)}
            tabIndex={0}
          >
            {children}
          </PillLabel>
        ) : (
          <PillLabel>{children}</PillLabel>
        )}
        <button
          type="button"
          className="browse-pill-action"
          aria-label={
            removeFeedback
              ? `${removeFeedback.label} · ${removeLabel}`
              : removeLabel
          }
          aria-live={removeFeedback ? 'polite' : undefined}
          aria-busy={removeFeedback?.phase === 'pending' || undefined}
          data-feedback={removeFeedback?.phase}
          data-icon=""
          disabled={removeDisabled}
          title={removeFeedback?.label ?? removeLabel}
          onClick={onRemove}
        >
          {removeFeedback ? (
            <ButtonFeedbackLabel feedback={removeFeedback}>
              <X className="ds-i" aria-hidden />
            </ButtonFeedbackLabel>
          ) : (
            <X className="ds-i" aria-hidden />
          )}
        </button>
      </span>
    </Pill>
  )
}

/** `storedTagNames` shows tag values from outside the tag library as stored. */
export function BrowseFilterChips({
  filters,
  fields,
  onChange,
  filterHref,
  storedTagNames = false,
}: {
  filters: BrowseFilter[]
  fields: BrowseField[]
  onChange: (filters: BrowseFilter[]) => void
  filterHref?: BrowseFilterHref
  storedTagNames?: boolean
}) {
  const providerName = useProviderDisplayName(
    filters.some((filter) => filter.field === 'provider'),
  )
  return filters.map((filter, index) => {
    const label =
      filter.mode === 'required'
        ? 'Required'
        : filter.mode === 'exclude'
          ? 'Excluded'
          : 'Any'
    const nextMode =
      filter.mode === 'required'
        ? 'exclude'
        : filter.mode === 'exclude'
          ? 'any'
          : 'required'
    const playlist = filter.field === LIBRARY_PLAYLIST_FILTER_FIELD
    const fieldLabel = playlist
      ? 'Playlist'
      : (fields.find((field) => field.key === filter.field)?.label ??
        filter.field)
    const value = playlist
      ? 'playlist'
      : storedTagNames
        ? filter.value
        : filter.field === 'provider'
          ? providerName(filter.value)
          : formatBrowseFilterValue(filter.field, filter.value)
    return (
      <BrowseFilterPill
        key={`${filter.field}:${filter.value}`}
        mode={filterPillMode(filter.mode)}
        title="Cycle Any / Required / Excluded"
        destination={
          filterHref && !playlist
            ? { href: filterHref(filter), label: value }
            : undefined
        }
        onActivate={() =>
          onChange(
            filters.map((item, i) =>
              i === index ? { ...item, mode: nextMode } : item,
            ),
          )
        }
        onRemove={() => onChange(filters.filter((_, i) => i !== index))}
        removeLabel={`Remove ${value} filter`}
      >
        {playlist ? (
          <>
            {label} · {fieldLabel}:{' '}
            <LibraryPlaylistChipName id={filter.value} />
          </>
        ) : (
          <>
            {label} · {fieldLabel}: {value}
          </>
        )}
      </BrowseFilterPill>
    )
  })
}

/** A playlist filter's value: the playlist's name, or "removed". */
function LibraryPlaylistChipName({ id }: { id: string }) {
  const name = useLibraryPlaylistNames([id])(id)
  return name === undefined ? '…' : libraryPlaylistChipValue(name)
}

export function RangeEditor({
  fields,
  ranges,
  onChange,
  presentation = 'popover',
}: {
  fields: BrowseField[]
  ranges: BrowseRange[]
  presentation?: 'popover' | 'panel'
  onChange: (ranges: BrowseRange[]) => void
}) {
  const [key, setKey] = useState(
    fields.find((field) => field.type !== 'text')?.key ?? '',
  )
  const [error, setError] = useState('')
  const field = fields.find((field) => field.key === key)
  const current = ranges.find((range) => range.field === key)
  const isDate = field?.type === 'date'
  const editor = (
    <form
      key={`${key}:${JSON.stringify(current)}`}
      className={
        presentation === 'panel'
          ? 'browse-form'
          : 'browse-form ds-pop browse-popover-panel'
      }
      onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        const parse = (name: string) => {
          const value = data.get(name)
          return typeof value === 'string' && value !== ''
            ? isDate
              ? Date.parse(value) + (name === 'max' ? 86400000 - 1 : 0)
              : Number(value)
            : undefined
        }
        const next = BrowseRangeSchema.safeParse({
          field: key,
          min: parse('min'),
          max: parse('max'),
          includeMissing: data.get('missing') === 'on',
        })
        if (!next.success) {
          setError('Check the range bounds.')
          return
        }
        setError('')
        onChange([...ranges.filter((range) => range.field !== key), next.data])
      }}
    >
      <label className="ds-field">
        <span className="ds-label">Field</span>
        <Select
          aria-label="Range field"
          value={key}
          onChange={(event) => {
            setKey(event.target.value)
            setError('')
          }}
        >
          {fields
            .filter((field) => field.type !== 'text')
            .map((field) => (
              <option value={field.key} key={field.key}>
                {field.label}
              </option>
            ))}
        </Select>
      </label>
      <div className="browse-form-pair">
        {['min', 'max'].map((name) => {
          const value = name === 'min' ? current?.min : current?.max
          return (
            <label className="ds-field" key={name}>
              <span className="ds-label">
                {name === 'min' ? 'Minimum' : 'Maximum'}
              </span>
              <input
                className="ds-input"
                name={name}
                type={isDate ? 'date' : 'number'}
                step="any"
                defaultValue={
                  value === undefined
                    ? ''
                    : isDate
                      ? new Date(value).toISOString().slice(0, 10)
                      : value
                }
              />
            </label>
          )
        })}
      </div>
      <label className="ds-checkrow">
        <input
          type="checkbox"
          className="ds-check"
          name="missing"
          defaultChecked={current?.includeMissing ?? false}
        />
        Include missing values
      </label>
      {error && (
        <p role="alert" className="browse-form-error">
          {error}
        </p>
      )}
      <div>
        <Button variant="primary" type="submit">
          Apply range
        </Button>
      </div>
    </form>
  )
  return presentation === 'panel' ? (
    <FilterPanelSection
      title="Ranges"
      icon={<SlidersHorizontal className="ds-i" data-size="sm" aria-hidden />}
      count={ranges.length}
      defaultOpen
    >
      {editor}
    </FilterPanelSection>
  ) : (
    <details className="browse-popover">
      <summary className="ds-btn">
        <SlidersHorizontal className="ds-i" data-size="sm" aria-hidden />
        Ranges
        {ranges.length ? ` (${ranges.length})` : ''}
      </summary>
      {editor}
    </details>
  )
}
