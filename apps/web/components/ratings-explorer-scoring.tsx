'use client'

import { useResultAction } from './result-feedback'
import { SlidersHorizontal, Settings2 } from 'lucide-react'
import {
  RatingsSettingsSchema,
  type RatingsSettings,
  type RatingsSource,
} from '@repo/schemas/ratings-explorer'
import { RatingWeightControl } from '@repo/ui/components/ds/ratings-explorer'
import { Select } from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { FilterPanelSection } from './browse-filter-panel'

export const normalizationLabels = {
  percentile: 'Library percentile',
  standardized: 'Standardised score',
  scale: 'Native scale to 100',
}

export const combinationLabels = {
  mean: 'Weighted mean',
  median: 'Weighted median',
  trimmed: 'Trimmed weighted mean',
}

export function settingFor(source: RatingsSource, settings: RatingsSettings) {
  return (
    settings.sources.find(({ key }) => key === source.key) ?? {
      key: source.key,
      weight: source.group === 'personal' ? 0 : 1,
      minVotes: 0,
    }
  )
}

// Remove default overrides so restoring a weight reuses the original ranking.
export function changeSource(
  settings: RatingsSettings,
  source: RatingsSource,
  changes: Partial<
    Pick<RatingsSettings['sources'][number], 'weight' | 'minVotes'>
  >,
): RatingsSettings {
  const effective = { ...settingFor(source, settings), ...changes }
  const sources = settings.sources.filter(({ key }) => key !== source.key)
  if (
    effective.weight !== (source.group === 'personal' ? 0 : 1) ||
    effective.minVotes !== 0
  )
    sources.push(effective)
  sources.sort((a, b) => a.key.localeCompare(b.key))
  return { ...settings, sources }
}

function NumberSetting({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}) {
  return (
    <label className="ratings-field">
      {label}
      <Input
        key={value}
        type="number"
        required
        defaultValue={value}
        min={min}
        max={max}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
        onBlur={(event) => {
          if (event.currentTarget.validity.valid)
            onChange(event.currentTarget.valueAsNumber)
          else event.currentTarget.value = String(value)
        }}
      />
    </label>
  )
}

export function RatingsScoring({
  settings,
  sources,
  onChange: changeSettings,
}: {
  settings: RatingsSettings
  sources: readonly RatingsSource[]
  onChange: (value: RatingsSettings) => void
}) {
  const scoring = useResultAction('scoring')
  const reset = useResultAction('reset-scoring')
  function onChange(value: RatingsSettings) {
    scoring.begin()
    changeSettings(value)
  }
  return (
    <div className="ratings-scoring">
      {scoring.feedback && <span role="status">{scoring.feedback.label}</span>}
      <FilterPanelSection
        title="Scoring"
        icon={<SlidersHorizontal className="ds-i" aria-hidden />}
        defaultOpen
      >
        <div className="ratings-weights">
          {sources.map((source) => (
            <RatingWeightControl
              key={source.key}
              label={source.label}
              value={settingFor(source, settings).weight}
              onChange={(weight) =>
                onChange(changeSource(settings, source, { weight }))
              }
            />
          ))}
        </div>
        <FilterPanelSection
          title="Scoring rules"
          icon={<Settings2 className="ds-i" aria-hidden />}
        >
          <div className="ratings-fields">
            <label className="ratings-field">
              Normalisation
              <Select
                aria-label="Normalisation"
                value={settings.normalization}
                onChange={(e) =>
                  onChange({
                    ...settings,
                    normalization:
                      RatingsSettingsSchema.shape.normalization.parse(
                        e.target.value,
                      ),
                  })
                }
              >
                {Object.entries(normalizationLabels).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="ratings-field">
              Combination
              <Select
                aria-label="Combination"
                value={settings.combine}
                onChange={(e) =>
                  onChange({
                    ...settings,
                    combine: RatingsSettingsSchema.shape.combine.parse(
                      e.target.value,
                    ),
                  })
                }
              >
                {Object.entries(combinationLabels).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
            <NumberSetting
              label="Minimum rated sources"
              min={1}
              max={64}
              value={settings.minSources}
              onChange={(minSources) => onChange({ ...settings, minSources })}
            />
            <label className="ratings-field">
              Missing ratings at the source average
              <Select
                aria-label="Missing ratings at the source average"
                value={settings.missingWeight}
                onChange={(e) =>
                  onChange({
                    ...settings,
                    missingWeight:
                      RatingsSettingsSchema.shape.missingWeight.parse(
                        Number(e.target.value),
                      ),
                  })
                }
              >
                <option value="0">Ignore</option>
                <option value="0.5">Half weight</option>
                <option value="1">Full weight</option>
              </Select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={settings.outlierDistance !== null}
                onChange={(event) =>
                  onChange({
                    ...settings,
                    outlierDistance: event.target.checked ? 25 : null,
                  })
                }
              />{' '}
              Exclude isolated ratings
            </label>
            {settings.outlierDistance !== null && (
              <NumberSetting
                label="Outlier distance (points)"
                value={settings.outlierDistance}
                min={5}
                max={90}
                onChange={(outlierDistance) =>
                  onChange({ ...settings, outlierDistance })
                }
              />
            )}
            {sources
              .filter((source) => source.hasVotes)
              .map((source) => (
                <NumberSetting
                  key={source.key}
                  label={source.label + ' minimum votes'}
                  min={0}
                  max={2147483647}
                  value={settingFor(source, settings).minVotes}
                  onChange={(minVotes) =>
                    onChange(changeSource(settings, source, { minVotes }))
                  }
                />
              ))}
            <Button
              feedback={reset.feedback}
              onClick={() => {
                reset.begin()
                changeSettings(RatingsSettingsSchema.parse({}))
              }}
            >
              Reset scoring
            </Button>
          </div>
        </FilterPanelSection>
      </FilterPanelSection>
    </div>
  )
}
