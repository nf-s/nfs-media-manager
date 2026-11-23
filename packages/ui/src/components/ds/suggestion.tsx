import type { ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '../ui/button'
import { Thumb, type ArtRatio } from './artwork'
import { Skeleton } from './feedback'
import { ListRow } from './list-row'

/**
 * Where a suggestion can be played: in the library, on Spotify, not on
 * Spotify, or not looked up on Spotify yet.
 */
export type SuggestionPlace = 'library' | 'spotify' | 'none' | 'unsearched'

export const suggestionPlaceLabels: Record<SuggestionPlace, string> = {
  library: 'In library',
  spotify: 'On Spotify',
  none: 'Not on Spotify',
  unsearched: 'Not looked up on Spotify',
}

/**
 * One similar album or track in a compact `List`. Its second line starts
 * with where it can be played, then `details` (artists, then the year or
 * length), followed by available genre badges. In the library the title
 * opens the item. External suggestions have their service link and add
 * button in the trailing actions. Leave `play` out where
 * the suggestion cannot be played: its slot is kept so titles line up.
 */
export function SuggestionRow({
  place,
  thumb,
  title,
  details,
  badges,
  play,
  actions,
}: {
  place: SuggestionPlace
  thumb: ReactNode
  title: ReactNode
  details: readonly (string | null | undefined)[]
  badges?: ReactNode
  play?: ReactNode
  actions?: ReactNode
}) {
  return (
    <ListRow
      className="ds-suggestion"
      thumb={thumb}
      title={title}
      by={[suggestionPlaceLabels[place], ...details]
        .filter((part) => part)
        .join(' · ')}
      play={play}
      action={actions}
    >
      {badges}
    </ListRow>
  )
}

/** The trailing ghost button that opens a suggestion on a service. */
export function SuggestionLink({
  href,
  service,
}: {
  href: string
  service: string
}) {
  return (
    <Button size="xs" variant="ghost" icon asChild>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={`Open on ${service} (new tab)`}
        aria-label={`Open on ${service} (opens in a new tab)`}
      >
        <ExternalLink className="ds-i" data-size="sm" aria-hidden />
      </a>
    </Button>
  )
}

/** A suggestion row still loading: artwork and two lines. */
export function SuggestionRowSkeleton({ ratio }: { ratio?: ArtRatio }) {
  return (
    <div className="ds-row" data-action="" aria-hidden="true">
      <Thumb ratio={ratio} className="ds-skel">
        {null}
      </Thumb>
      <div className="ds-row-main ds-skel-lines">
        <Skeleton width="60%" />
        <Skeleton width="38%" />
      </div>
      <span />
      <span />
    </div>
  )
}
