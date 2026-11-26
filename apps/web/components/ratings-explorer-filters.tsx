'use client'

import { useEffect, useRef, useState } from 'react'
import {
  RatingsRankingRequestSchema,
  type RatingsRankingRequest,
} from '@repo/schemas/ratings-explorer'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Select } from '@repo/ui/components/ds/toolbar'
import { Input } from '@repo/ui/components/ui/input'
import { useBrowseFacets } from '@/hooks/useBrowseFacets'
import { useConfig } from './providers'

export type RatingFilters = Pick<
  RatingsRankingRequest,
  'tag' | 'tagField' | 'yearFrom' | 'yearTo' | 'watched' | 'minPlays'
>

export function RatingsFilters({
  request,
  onChange,
}: {
  request: RatingsRankingRequest
  onChange: (filters: RatingFilters) => void
}) {
  const [error, setError] = useState('')
  const { apiBaseUrl } = useConfig()
  const [draftTag, setDraftTag] = useState(request.tag)
  const facets = useBrowseFacets(
    apiBaseUrl,
    request.library === 'film' ? 'films' : 'albums',
    draftTag,
  )
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  function commit(form: HTMLFormElement, delay: boolean) {
    clearTimeout(timer.current)
    const data = new FormData(form)
    const numeric = (key: string) =>
      data.get(key) ? Number(data.get(key)) : undefined
    const tag = String(data.get('tag') ?? '').trim()
    const filters = {
      tag,
      tagField: tag === request.tag ? request.tagField : undefined,
      yearFrom: numeric('yearFrom'),
      yearTo: numeric('yearTo'),
      minPlays: numeric('minPlays'),
      watched:
        data.get('watched') === 'yes'
          ? true
          : data.get('watched') === 'no'
            ? false
            : undefined,
    }
    const parsed = RatingsRankingRequestSchema.safeParse({
      ...request,
      ...filters,
    })
    if (!parsed.success || !form.checkValidity()) {
      setError(parsed.error?.issues[0]?.message ?? 'Check the filter values.')
      return
    }
    setError('')
    if (delay) timer.current = setTimeout(() => onChange(filters), 300)
    else onChange(filters)
  }
  return (
    <form
      className="ratings-options"
      aria-label="Rating filters"
      onSubmit={(e) => {
        e.preventDefault()
        commit(e.currentTarget, false)
      }}
      onChange={(e) =>
        commit(e.currentTarget, !(e.target instanceof HTMLSelectElement))
      }
    >
      <div className="ratings-fields">
        <label className="ratings-field">
          Tag
          <Input
            list="rating-tags"
            name="tag"
            value={draftTag}
            maxLength={200}
            placeholder="Any"
            onFocus={facets.activate}
            onChange={(e) => setDraftTag(e.target.value)}
          />
          <datalist id="rating-tags">
            {facets.data
              ?.filter((f) => f.field === 'genre')
              .map((f) => (
                <option key={f.value} value={f.value} />
              ))}
          </datalist>
        </label>
        <label className="ratings-field">
          Year from
          <Input
            type="number"
            name="yearFrom"
            min={1}
            max={9999}
            defaultValue={request.yearFrom}
          />
        </label>
        <label className="ratings-field">
          Year to
          <Input
            type="number"
            name="yearTo"
            min={1}
            max={9999}
            defaultValue={request.yearTo}
          />
        </label>
        {request.library === 'film' ? (
          <label className="ratings-field">
            Watched
            <Select
              name="watched"
              aria-label="Watched"
              defaultValue={
                request.watched === undefined
                  ? ''
                  : request.watched
                    ? 'yes'
                    : 'no'
              }
            >
              <option value="">Any</option>
              <option value="yes">Watched</option>
              <option value="no">Not watched</option>
            </Select>
          </label>
        ) : (
          <label className="ratings-field">
            Plays, at least
            <Input
              type="number"
              min={0}
              max={2147483647}
              name="minPlays"
              defaultValue={request.minPlays}
            />
          </label>
        )}
      </div>
      <p className="ds-help">
        To filter by a rating, score or spread, pick bars on the Sources view.
      </p>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  )
}
