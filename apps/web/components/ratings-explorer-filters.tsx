'use client'

import { useEffect, useRef, useState } from 'react'
import {
  RatingsRankingRequestSchema,
  type RatingsRankingRequest,
} from '@repo/schemas/ratings-explorer'
import { formatTagName } from '@repo/schemas/tags'
import { Notice } from '@repo/ui/components/ds/feedback'
import { SearchSelect } from '@repo/ui/components/ds/sort-picker'
import { Select } from '@repo/ui/components/ds/toolbar'
import { Input } from '@repo/ui/components/ui/input'
import { useBrowseFacets } from '@/hooks/useBrowseFacets'
import { useConfig } from './providers'

export type RatingFilters = Pick<
  RatingsRankingRequest,
  'tag' | 'tagField' | 'yearFrom' | 'yearTo' | 'watched' | 'minPlays'
>

type TagSelection = Pick<RatingFilters, 'tag' | 'tagField'>
export function ratingTagLabel({ tag, tagField }: TagSelection) {
  return tag
    ? formatTagName(tag) + (tagField === 'artistTag' ? ' (artist tag)' : '')
    : 'Any'
}
function tagOption({ tag, tagField }: TagSelection) {
  return {
    key: tag ? `${tagField ?? 'genre'}:${tag}` : '',
    label: ratingTagLabel({ tag, tagField }),
    tag,
    tagField,
  }
}

export function RatingsFilters({
  request,
  onChange,
}: {
  request: RatingsRankingRequest
  onChange: (filters: RatingFilters) => void
}) {
  const [error, setError] = useState('')
  const { apiBaseUrl } = useConfig()
  const formRef = useRef<HTMLFormElement>(null)
  const [draftTag, setDraftTag] = useState('')
  const [tagOpen, setTagOpen] = useState(false)
  const facets = useBrowseFacets(
    apiBaseUrl,
    request.library === 'film' ? 'films' : 'albums',
    draftTag,
    tagOpen,
  )
  const selected = tagOption(request)
  const options = (facets.data ?? []).flatMap(({ field, value }) =>
    field === 'genre' || (request.library === 'album' && field === 'artistTag')
      ? [
          tagOption({
            tag: value,
            tagField: field === 'artistTag' ? field : undefined,
          }),
        ]
      : [],
  )
  if (
    !draftTag.trim() &&
    selected.tag &&
    !options.some((option) => option.key === selected.key)
  )
    options.push(selected)
  options.sort((a, b) => a.label.localeCompare(b.label))
  if (!draftTag.trim()) options.unshift(tagOption({ tag: '' }))
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  function commit(
    form: HTMLFormElement,
    delay: boolean,
    selection: TagSelection = request,
  ) {
    clearTimeout(timer.current)
    const data = new FormData(form)
    const numeric = (key: string) =>
      data.get(key) ? Number(data.get(key)) : undefined
    const filters = {
      tag: selection.tag,
      tagField: selection.tagField,
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
      ref={formRef}
      className="ratings-options"
      aria-label="Rating filters"
      onSubmit={(e) => {
        e.preventDefault()
        commit(e.currentTarget, false)
      }}
      onChange={(e) => {
        if (e.target instanceof HTMLSelectElement)
          commit(e.currentTarget, false)
        else if (e.target instanceof HTMLInputElement && e.target.name)
          commit(e.currentTarget, true)
      }}
    >
      <div className="ratings-fields">
        <div className="ratings-field">
          Tag
          <SearchSelect
            label="Tag"
            searchLabel="Find a tag"
            value={selected.key}
            selectedLabel={selected.label}
            options={options}
            emptyMessage="No matching tags."
            statusMessage={
              facets.isDebouncing || facets.isPending
                ? 'Loading tags…'
                : facets.isError
                  ? 'Could not load tags.'
                  : undefined
            }
            onOpenChange={(open) => {
              setTagOpen(open)
              if (open) facets.activate()
            }}
            onSearch={setDraftTag}
            onChange={(key) => {
              const choice = options.find((option) => option.key === key)
              if (choice && formRef.current)
                commit(formRef.current, false, choice)
            }}
          />
        </div>
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
