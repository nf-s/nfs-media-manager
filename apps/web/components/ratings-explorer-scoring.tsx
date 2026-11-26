'use client'

import { useResultAction } from './result-feedback'
import { useState } from 'react'
import { Segmented } from '@repo/ui/components/ds/segmented'
import {
  RatingsSettingsSchema,
  type RatingsSettings,
  type RatingsSource,
} from '@repo/schemas/ratings-explorer'
import { RatingWeightControl } from '@repo/ui/components/ds/ratings-explorer'
import { Select } from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'

export const normalizationLabels = {
  percentile: 'Percentile',
  standardized: 'Standardised',
  scale: 'Scale only',
}

export const combinationLabels = {
  mean: 'Weighted mean',
  median: 'Weighted median',
  trimmed: 'Mean without the highest and lowest',
}

type Preset = 'equal' | 'critics' | 'audience'
const presets: { group: Preset; label: string }[] = [
  { group: 'equal', label: 'Equal' },
  { group: 'critics', label: 'Critics only' },
  { group: 'audience', label: 'Audiences only' },
]

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
  caption,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  caption?: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}) {
  return (
    <label className="ds-actions">
      {caption}
      <Input
        aria-label={label}
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
  libraryTotal,
  onChange: changeSettings,
}: {
  settings: RatingsSettings
  sources: readonly RatingsSource[]
  libraryTotal: number
  onChange: (value: RatingsSettings) => void
}) {
  const scoring = useResultAction('scoring')
  const [distance, setDistance] = useState(settings.outlierDistance ?? 25)
  function change(value: RatingsSettings) {
    scoring.begin()
    changeSettings(value)
  }
  function preset(group: Preset) {
    const eligible = sources.filter((s) => s.group === group).length
    let next = {
      ...settings,
      minSources:
        group === 'equal'
          ? settings.minSources
          : Math.max(1, Math.min(settings.minSources, eligible)),
    }
    for (const source of sources)
      next = changeSource(next, source, {
        weight:
          source.group !== 'personal' &&
          (group === 'equal' || source.group === group)
            ? 1
            : 0,
      })
    change(next)
  }
  return (
    <section aria-label="Scoring settings" className="ratings-options">
      <div className="ratings-fields">
        <div className="ratings-field">
          <span className="ds-label">Compare ratings by</span>
          <Segmented
            label="Compare ratings by"
            value={settings.normalization}
            options={[
              { value: 'percentile', label: 'Percentile' },
              { value: 'standardized', label: 'Standardised' },
              { value: 'scale', label: 'Scale only' },
            ]}
            onChange={(normalization) => change({ ...settings, normalization })}
          />
          <span className="ds-help">
            {settings.normalization === 'percentile'
              ? '80 means this source rates the item above 80% of the items it has rated here.'
              : settings.normalization === 'scale'
                ? 'Rescale each source to 0–100.'
                : '50 is the source average. Each 20 points is one standard deviation.'}
          </span>
        </div>
        <label className="ratings-field">
          Combine with
          <Select
            value={settings.combine}
            onChange={(e) =>
              change({
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
          <span className="ds-help">
            {settings.combine === 'trimmed'
              ? 'Applies to items with four or more ratings.'
              : settings.combine === 'median'
                ? 'The middle rating by weight.'
                : 'Each rating moves the score in proportion to its weight.'}
          </span>
        </label>
        <div className="ratings-field">
          <span className="ds-label">
            A missing or left-out rating counts as
          </span>
          <Segmented
            label="A missing or left-out rating counts as"
            value={String(settings.missingWeight)}
            options={[
              { value: '0', label: 'Nothing' },
              { value: '0.5', label: 'Half an average one' },
              { value: '1', label: 'An average one' },
            ]}
            onChange={(v) =>
              change({
                ...settings,
                missingWeight: RatingsSettingsSchema.shape.missingWeight.parse(
                  Number(v),
                ),
              })
            }
          />
        </div>
      </div>
      <div className="ds-cond">
        <div className="ds-cond-line">
          Score an item when it has at least{' '}
          <NumberSetting
            label="Minimum ratings"
            value={settings.minSources}
            min={1}
            max={Math.max(1, sources.length)}
            onChange={(minSources) => change({ ...settings, minSources })}
          />{' '}
          counted ratings
        </div>
        <div className="ds-cond-line">
          <label className="ds-checkrow">
            <input
              type="checkbox"
              className="ds-check"
              checked={settings.outlierDistance !== null}
              onChange={(e) =>
                change({
                  ...settings,
                  outlierDistance: e.target.checked ? distance : null,
                })
              }
            />
            Leave out a rating more than
          </label>
          <NumberSetting
            label="Points from the median"
            min={5}
            max={90}
            value={settings.outlierDistance ?? distance}
            onChange={(v) => {
              setDistance(v)
              if (settings.outlierDistance !== null)
                change({ ...settings, outlierDistance: v })
            }}
          />{' '}
          points from the item's median
        </div>
      </div>
      <h3>Weights</h3>
      <p className="ds-help">
        The percentage is how much of the library the source has rated.
      </p>
      <div className="ratings-weights">
        <div className="ratings-weight-row ds-muted" aria-hidden="true">
          <span>Source</span>
          <span>Weight</span>
          <span />
          <span>Votes</span>
        </div>
        {sources.map((source) => (
          <div className="ratings-weight-row" key={source.key}>
            <RatingWeightControl
              label={source.label}
              coverage={
                source.recorded === undefined
                  ? undefined
                  : libraryTotal
                    ? Math.round((100 * source.recorded) / libraryTotal)
                    : 0
              }
              value={settingFor(source, settings).weight}
              onChange={(weight) =>
                change(changeSource(settings, source, { weight }))
              }
            />
            {source.hasVotes && (
              <NumberSetting
                label={source.label + ' minimum votes'}
                caption="min"
                min={0}
                max={2147483647}
                value={settingFor(source, settings).minVotes}
                onChange={(minVotes) =>
                  change(changeSource(settings, source, { minVotes }))
                }
              />
            )}
          </div>
        ))}
      </div>
      <div className="ds-actions">
        {presets.map(({ group, label }) => (
          <Button size="xs" key={group} onClick={() => preset(group)}>
            {label}
          </Button>
        ))}
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            setDistance(25)
            change(RatingsSettingsSchema.parse({}))
          }}
        >
          Reset scoring
        </Button>
      </div>
    </section>
  )
}
