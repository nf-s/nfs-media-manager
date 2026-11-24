'use client'

import { Filter, Library } from 'lucide-react'
import { Select, ToolbarToggle } from '@repo/ui/components/ds/toolbar'
import {
  discoverySourceLabels,
  libraryScopeLabels,
  type LibraryScopeState,
} from '@/utils/library-scope'
import { BrowseFilterPill } from './browse-controls'
import { FilterPanelSection } from './browse-filter-panel'

export type LibraryScopeControl = {
  kind?: 'track'
  value: LibraryScopeState
  onChange: (value: LibraryScopeState) => void
}

export function LibraryScopeToggle({ value, onChange }: LibraryScopeControl) {
  const label = 'Include outside library'
  const description = libraryScopeLabels[value.scope]
  return (
    <ToolbarToggle
      iconButton
      pressed={value.scope === 'all'}
      onPressedChange={(pressed) =>
        onChange({ ...value, scope: pressed ? 'all' : 'library' })
      }
      aria-label={label}
      aria-description={description}
      title={`${label} · ${description}`}
      icon={<Library className="ds-i" data-size="sm" aria-hidden />}
    />
  )
}

export function LibraryScopeSections({
  kind,
  value,
  onChange,
}: LibraryScopeControl) {
  const sources = new Set([
    ...(kind === 'track'
      ? ['album-tracks', 'playlist-contents', 'similar']
      : discoverySourceLabels.keys()),
    ...value.sources,
  ])
  return (
    <>
      <FilterPanelSection
        title="Library scope"
        icon={<Library className="ds-i" data-size="sm" aria-hidden />}
        defaultOpen
      >
        <label className="ds-field">
          <span className="ds-label">Show</span>
          <Select
            value={value.scope}
            onChange={({ target }) => {
              const scope = target.value
              if (scope === 'library' || scope === 'outside' || scope === 'all')
                onChange({ ...value, scope })
            }}
          >
            {Object.entries(libraryScopeLabels).map(([scope, label]) => (
              <option key={scope} value={scope}>
                {label}
              </option>
            ))}
          </Select>
        </label>
      </FilterPanelSection>
      <FilterPanelSection
        title="Discovery sources"
        icon={<Filter className="ds-i" data-size="sm" aria-hidden />}
        count={value.sources.length}
      >
        <div className="browse-form">
          <div className="browse-check-list">
            {[...sources].map((source) => (
              <label key={source} className="ds-checkrow">
                <input
                  type="checkbox"
                  className="ds-check"
                  checked={value.sources.includes(source)}
                  onChange={({ target }) =>
                    onChange({
                      ...value,
                      scope:
                        target.checked &&
                        !value.selection &&
                        value.scope === 'library'
                          ? 'all'
                          : value.scope,
                      sources: target.checked
                        ? [...value.sources, source]
                        : value.sources.filter((item) => item !== source),
                    })
                  }
                />
                {discoverySourceLabels.get(source) ?? source}
              </label>
            ))}
          </div>
          <label className="ds-field">
            <span className="ds-label">Match sources</span>
            <Select
              value={value.mode}
              onChange={({ target }) =>
                onChange({
                  ...value,
                  mode:
                    target.value === 'exclude'
                      ? 'exclude'
                      : target.value === 'all'
                        ? 'all'
                        : 'any',
                })
              }
            >
              <option value="any">Any selected</option>
              <option value="all">All selected</option>
              <option value="exclude">Exclude selected</option>
            </Select>
          </label>
          <label className="ds-checkrow">
            <input
              type="checkbox"
              className="ds-check"
              checked={Boolean(value.selection)}
              onChange={({ target }) =>
                onChange({ ...value, selection: target.checked })
              }
            />
            Apply source filters to library items
          </label>
        </div>
      </FilterPanelSection>
    </>
  )
}

export function LibraryScopePills({ value, onChange }: LibraryScopeControl) {
  if (value.scope === 'library' && !value.selection) return null
  return (
    <>
      {value.scope === 'outside' && (
        <BrowseFilterPill
          removeLabel="Remove Outside library scope"
          onRemove={() => onChange({ ...value, scope: 'all' })}
        >
          Outside library
        </BrowseFilterPill>
      )}
      {value.sources.map((source) => {
        const label = discoverySourceLabels.get(source) ?? source
        return (
          <BrowseFilterPill
            key={source}
            removeLabel={`Remove discovery source ${label}`}
            onRemove={() =>
              onChange({
                ...value,
                sources: value.sources.filter((item) => item !== source),
              })
            }
          >
            {label}
          </BrowseFilterPill>
        )
      })}
    </>
  )
}
