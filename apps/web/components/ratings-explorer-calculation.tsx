'use client'

import { useEffect, useRef, type MouseEvent } from 'react'
import { X } from 'lucide-react'
import type {
  RatingsRankingRequest,
  RatingsRankingRow,
  RatingsSource,
  RatingsSettings,
  RatingsObservation,
} from '@repo/schemas/ratings-explorer'
import { Section, KeyValues } from '@repo/ui/components/ds/facts'
import { Button } from '@repo/ui/components/ui/button'
import {
  Table,
  TableBody,
  TableHeader,
  TableHead,
  TableCell,
  TableRow,
} from '@repo/ui/components/ui/table'
import { EMPTY_VALUE, formatCount } from '@repo/ui/lib/format'
import { DetailLink } from './detail-link'
import { MediaInspector } from './media-inspector'
import {
  combinationLabels,
  normalizationLabels,
  settingFor,
} from './ratings-explorer-scoring'

export function displayedScore(value: number | null) {
  return value === null ? EMPTY_VALUE : value.toFixed(2)
}

export function nativeScore(value: number | null, scale: number) {
  return value === null
    ? EMPTY_VALUE
    : value.toLocaleString('en', {
        minimumFractionDigits: scale <= 10 ? 1 : 0,
        maximumFractionDigits: 2,
      })
}

const calculationNumber = new Intl.NumberFormat('en', {
  maximumFractionDigits: 8,
})
const number = calculationNumber.format
const statusLabels: Record<RatingsObservation['status'], string> = {
  counted: 'Counted',
  missing: 'Missing rating',
  disabled: 'Zero weight',
  votes: 'Below vote minimum',
  outlier: 'Excluded outlier',
  trimmed: 'Qualified, trimmed from mean',
}
const normalizationHelp = {
  percentile: 'Adjusted values use tied ranks within each source’s library.',
  standardized:
    'Each source is centred at 50, with 20 points per population standard deviation, limited to 0–100.',
  scale: 'Each native rating is divided by its scale and multiplied by 100.',
}

type WeightedRating = { value: number; weight: number }

function weightedTerm({ value, weight }: WeightedRating) {
  return `${number(value)} × ${number(weight)}`
}

function combinationProof(
  combine: RatingsSettings['combine'],
  counted: WeightedRating[],
  core: number | null,
) {
  if (core === null) return EMPTY_VALUE
  const totalWeight = counted.reduce((sum, entry) => sum + entry.weight, 0)
  if (combine === 'median') {
    const ordered = [...counted].sort((a, b) => a.value - b.value)
    const terms = ordered.map(weightedTerm).join(', ')
    return `Ordered ratings (value × weight) ${terms}. Half the qualifying weight is ${number(totalWeight / 2)}. Weighted midpoint ≈ ${number(core)}.`
  }
  return `(${counted.map(weightedTerm).join(' + ')}) ÷ ${number(totalWeight)} ≈ ${number(core)}`
}

function combinedProof(row: RatingsRankingRow) {
  if (row.core === null || row.score === null) return 'Unscored'
  const observed = number(row.observedWeight)
  return `(${number(row.core)} × ${observed} + ${number(row.missingSum)}) ÷ (${observed} + ${number(row.missingWeight)}) ≈ ${displayedScore(row.score)}`
}

export function RatingsCalculation({
  row,
  sources,
  library,
  settings,
  onClose,
}: {
  row: RatingsRankingRow
  sources: readonly RatingsSource[]
  library: RatingsRankingRequest['library']
  settings: RatingsSettings
  onClose: () => void
}) {
  const inspector = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    inspector.current?.focus({ preventScroll: true })
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [onClose])
  function follow(event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.button === 0 &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.altKey
    )
      onClose()
  }
  const fields = row.ratings.flatMap((observation) => {
    const source = sources.find((s) => s.key === observation.key)
    if (!source) return []
    const { weight, minVotes } = settingFor(source, settings)
    const eligible =
      observation.status === 'counted' || observation.status === 'trimmed'
    const baselineWeight =
      !eligible && observation.center !== null
        ? weight * settings.missingWeight
        : 0
    return [{ source, observation, weight, minVotes, baselineWeight }]
  })
  const counted = fields.flatMap(({ observation, weight }) =>
    observation.status === 'counted' && observation.adjusted !== null
      ? [{ value: observation.adjusted, weight }]
      : [],
  )
  const baselineTerms = fields.flatMap(({ observation, baselineWeight }) =>
    baselineWeight > 0 && observation.center !== null
      ? [weightedTerm({ value: observation.center, weight: baselineWeight })]
      : [],
  )
  const shortfall = Math.max(0, settings.minSources - row.counted)
  return (
    <>
      <div className="inspector-backdrop" onClick={onClose} />
      <MediaInspector
        ref={inspector}
        tabIndex={-1}
        aria-label="Rating calculation"
        onDismiss={onClose}
        headerClassName="ds-inspector-bar dtl-bar"
        header={
          <>
            <div className="dtl-bar-start">
              <div className="ds-crumbs">
                <b>Rating calculation</b>
              </div>
            </div>
            <span className="dtl-bar-end">
              <Button
                icon
                variant="ghost"
                aria-label="Close calculation"
                onClick={onClose}
              >
                <X className="ds-i" aria-hidden />
              </Button>
            </span>
          </>
        }
      >
        <div className="inspector-scroll dtl-body">
          <Section
            title={row.title}
            aside={
              <DetailLink
                kind={library}
                id={row.id}
                tab="sources"
                onClick={follow}
              >
                Sources
              </DetailLink>
            }
          >
            <KeyValues
              items={[
                {
                  label: 'Combined score',
                  value:
                    row.score === null
                      ? 'Unscored'
                      : displayedScore(row.score) + ' / 100',
                },
                {
                  label: 'Qualified ratings',
                  value:
                    formatCount(row.counted) +
                    ' of ' +
                    formatCount(
                      fields.filter((field) => field.weight > 0).length,
                    ),
                },
                {
                  label: 'Normalisation',
                  value: normalizationLabels[settings.normalization],
                },
                {
                  label: 'Combination',
                  value: combinationLabels[settings.combine],
                },
              ]}
            />
            {shortfall > 0 && (
              <p>
                Needs {formatCount(shortfall)} more qualifying{' '}
                {shortfall === 1 ? 'rating' : 'ratings'} to reach the minimum of{' '}
                {formatCount(settings.minSources)}.
              </p>
            )}
          </Section>
          <Section
            title="Rating inputs"
            note={normalizationHelp[settings.normalization]}
          >
            <Table aria-label="Rating inputs">
              <TableHeader>
                <TableRow>
                  {[
                    'Source',
                    'Native rating',
                    'Votes',
                    'Adjusted',
                    'Weight',
                    'Eligibility',
                    'Source average',
                    'Baseline weight',
                  ].map((text) => (
                    <TableHead key={text}>{text}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {fields.map(
                  ({
                    source,
                    observation,
                    weight,
                    minVotes,
                    baselineWeight,
                  }) => (
                    <TableRow key={source.key}>
                      <TableCell>{source.label}</TableCell>
                      <TableCell>
                        <DetailLink
                          kind={library}
                          id={row.id}
                          onClick={follow}
                          view={{
                            fieldsExpanded: 'true',
                            provenanceField: source.key,
                          }}
                          aria-label={'Evidence for ' + source.label}
                        >
                          {observation.raw === null
                            ? 'Missing'
                            : number(observation.raw) + ' / ' + source.scale}
                        </DetailLink>
                      </TableCell>
                      <TableCell>
                        {source.votesKey ? (
                          <DetailLink
                            kind={library}
                            id={row.id}
                            view={{
                              fieldsExpanded: 'true',
                              provenanceField: source.votesKey,
                            }}
                            onClick={follow}
                            aria-label={'Vote evidence for ' + source.label}
                          >
                            {observation.votes === null
                              ? 'Unknown'
                              : formatCount(observation.votes)}
                          </DetailLink>
                        ) : source.hasVotes ? (
                          observation.votes === null ? (
                            'Unknown'
                          ) : (
                            formatCount(observation.votes)
                          )
                        ) : (
                          EMPTY_VALUE
                        )}
                      </TableCell>
                      <TableCell>
                        {observation.adjusted === null
                          ? EMPTY_VALUE
                          : number(observation.adjusted)}
                      </TableCell>
                      <TableCell>{weight}×</TableCell>
                      <TableCell>
                        {statusLabels[observation.status]}
                        {observation.status === 'votes'
                          ? ' (' + formatCount(minVotes) + ')'
                          : null}
                      </TableCell>
                      <TableCell>
                        {observation.center === null
                          ? EMPTY_VALUE
                          : number(observation.center)}
                      </TableCell>
                      <TableCell>{baselineWeight}×</TableCell>
                    </TableRow>
                  ),
                )}
              </TableBody>
            </Table>
          </Section>
          <Section title="Calculation">
            <KeyValues
              items={[
                {
                  label: combinationLabels[settings.combine],
                  value: combinationProof(settings.combine, counted, row.core),
                },
                {
                  label: 'Qualifying weight',
                  value: number(row.observedWeight),
                },
                { label: 'Missing weight', value: number(row.missingWeight) },
                {
                  label: 'Weighted source averages',
                  value: baselineTerms.length
                    ? baselineTerms.join(' + ') + ' ≈ ' + number(row.missingSum)
                    : '0',
                },
                {
                  label: 'Combined score',
                  value: combinedProof(row),
                },
              ]}
            />
          </Section>
        </div>
      </MediaInspector>
    </>
  )
}
