'use client'

import { Tags } from 'lucide-react'
import {
  tagLevelOrder,
  type TagLevel,
  type TagLevels,
} from '@repo/schemas/browse'
import { TagLocation } from '@repo/ui/components/ds/tag-location'
import { tagLevelLabels } from '@/utils/browse-items'
import { FilterPanelSection } from './browse-filter-panel'

const levels = tagLevelOrder.map((value) => ({
  value,
  label: tagLevelLabels[value],
}))

const libraries: Record<
  'track' | 'album',
  { defaults: TagLevel[]; auto: string; levels: string }
> = {
  track: {
    defaults: ['track'],
    auto: 'Each track’s own tags; its album’s and artists’ tags for tags that tracks do not carry, or when it has none.',
    levels: 'A track matches when any ticked level has the tag.',
  },
  album: {
    defaults: ['album', 'artist'],
    auto: 'The album’s tags; its artists’ tags when it has fewer than two.',
    levels: 'An album matches when any ticked level has the tag.',
  },
}

/**
 * The Filters drawer section choosing where a list's Tags filters and Tags
 * suggestion counts read tags. It is not a filter: it adds nothing to the
 * filter count and Clear filters leaves it.
 */
export function TagLocationSection({
  library,
  value,
  onChange,
}: {
  library: 'track' | 'album'
  /** `undefined` is Auto. */
  value: TagLevels | undefined
  onChange: (value: TagLevels | undefined) => void
}) {
  const copy = libraries[library]
  return (
    <FilterPanelSection
      title="Tag location"
      icon={<Tags className="ds-i" data-size="sm" aria-hidden />}
      defaultOpen={value !== undefined}
    >
      <TagLocation
        levels={levels}
        value={value}
        defaults={copy.defaults}
        hint={value === undefined ? copy.auto : copy.levels}
        onChange={onChange}
      />
    </FilterPanelSection>
  )
}
