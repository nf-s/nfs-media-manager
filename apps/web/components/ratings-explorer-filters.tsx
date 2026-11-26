'use client'

import { useState } from 'react'
import { ListFilter } from 'lucide-react'
import {
  RatingsRankingRequestSchema,
  defaultRatingsRankingRequest,
  type RatingsRankingRequest,
} from '@repo/schemas/ratings-explorer'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Select } from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import BrowseFilterPanel, { FilterPanelSection } from './browse-filter-panel'

type Filters = Pick<
  RatingsRankingRequest,
  'tag' | 'yearFrom' | 'yearTo' | 'minPlays' | 'watched' | 'scoredOnly'
>

export function RatingsFilters({
  request,
  onChange,
}: {
  request: RatingsRankingRequest
  onChange: (filters: Filters) => void
}) {
  const [error, setError] = useState('')
  const { library, tag, yearFrom, yearTo, minPlays, watched, scoredOnly } =
    request
  const count = [
    Boolean(tag),
    yearFrom !== undefined || yearTo !== undefined,
    watched !== undefined,
    minPlays !== undefined,
    scoredOnly,
  ].filter(Boolean).length
  return (
    <BrowseFilterPanel count={count}>
      <FilterPanelSection
        title="Ranking filters"
        icon={<ListFilter className="ds-i" aria-hidden />}
        defaultOpen
      >
        <form
          className="data-stack"
          key={JSON.stringify([
            tag,
            yearFrom,
            yearTo,
            minPlays,
            watched,
            scoredOnly,
          ])}
          onSubmit={(event) => {
            event.preventDefault()
            const data = new FormData(event.currentTarget)
            function numeric(name: string) {
              const value = data.get(name)
              return value ? Number(value) : undefined
            }
            const watched = data.get('watched')
            const filters = {
              tag: String(data.get('tag') ?? '').trim(),
              yearFrom: numeric('yearFrom'),
              yearTo: numeric('yearTo'),
              minPlays: numeric('minPlays'),
              watched:
                watched === 'yes' ? true : watched === 'no' ? false : undefined,
              scoredOnly: data.has('scoredOnly'),
            }
            const result = RatingsRankingRequestSchema.safeParse({
              ...request,
              ...filters,
            })
            if (!result.success) {
              setError(result.error.issues[0]?.message ?? 'Check the filters.')
              return
            }
            setError('')
            onChange(filters)
          }}
        >
          <label className="ratings-field">
            Tag
            <Input name="tag" defaultValue={tag} maxLength={200} />
          </label>
          <div className="ratings-fields">
            <label className="ratings-field">
              From year
              <Input
                name="yearFrom"
                type="number"
                min="1"
                max="9999"
                defaultValue={yearFrom}
              />
            </label>
            <label className="ratings-field">
              Through year
              <Input
                name="yearTo"
                type="number"
                min="1"
                max="9999"
                defaultValue={yearTo}
              />
            </label>
          </div>
          {library === 'film' ? (
            <label className="ratings-field">
              Watched
              <Select
                aria-label="Watched"
                name="watched"
                defaultValue={
                  watched === undefined ? '' : watched ? 'yes' : 'no'
                }
              >
                <option value="">Any</option>
                <option value="yes">Watched</option>
                <option value="no">Unwatched</option>
              </Select>
            </label>
          ) : (
            <label className="ratings-field">
              Minimum plays
              <Input
                type="number"
                min="0"
                max="2147483647"
                name="minPlays"
                defaultValue={minPlays}
              />
            </label>
          )}
          <label>
            <input
              type="checkbox"
              name="scoredOnly"
              defaultChecked={scoredOnly}
            />{' '}
            Only show items with a combined score
          </label>
          {error && <Notice tone="danger">{error}</Notice>}
          <div className="ds-actions">
            <Button type="submit" variant="primary">
              Apply filters
            </Button>
            <Button
              type="button"
              onClick={(event) => {
                const defaults = defaultRatingsRankingRequest(library)
                const form = event.currentTarget.form
                form?.reset()
                setError('')
                onChange({
                  tag: '',
                  yearFrom: undefined,
                  yearTo: undefined,
                  minPlays: undefined,
                  watched: undefined,
                  scoredOnly: defaults.scoredOnly,
                })
              }}
            >
              Reset filters
            </Button>
          </div>
        </form>
      </FilterPanelSection>
    </BrowseFilterPanel>
  )
}
