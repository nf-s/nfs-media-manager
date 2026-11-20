import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

/**
 * The one header for every item: artwork, kind, title, creator, one line of
 * facts, the item's service logos on a line of their own, then actions. The
 * title is 18px in the drawer and 22px on a standalone page (inside
 * `.ds-page`). `play` is the play pair, under the artwork and as wide as it;
 * an item without artwork starts its actions with it.
 */
export function DetailHeader({
  art,
  kind,
  title,
  by,
  facts = [],
  play,
  links,
  actions,
  headingLevel = 2,
  className,
}: {
  art?: ReactNode
  kind: string
  title: ReactNode
  by?: ReactNode
  facts?: readonly ReactNode[]
  play?: ReactNode
  links?: ReactNode
  actions?: ReactNode
  headingLevel?: 1 | 2
  className?: string
}) {
  const Heading = headingLevel === 1 ? 'h1' : 'h2'
  const shown = facts.filter(
    (fact) => fact != null && fact !== false && fact !== '',
  )
  const hasPlay = play != null && play !== false
  const playInRow = hasPlay && !art
  const hasActions = actions != null && actions !== false
  return (
    <header
      className={cn('ds-detail-head', className)}
      data-art={art ? undefined : 'none'}
    >
      {art && hasPlay ? (
        <div className="ds-detail-side">
          {art}
          <div className="ds-detail-play">{play}</div>
        </div>
      ) : (
        art
      )}
      <div>
        <div className="ds-kicker">{kind}</div>
        <Heading className="ds-detail-title">{title}</Heading>
        {by != null && by !== false && <div className="ds-detail-by">{by}</div>}
        {shown.length > 0 && (
          <div className="ds-detail-facts">
            {shown.map((fact, index) => (
              <span key={index}>{fact}</span>
            ))}
          </div>
        )}
        {links != null && links !== false && (
          <div className="ds-detail-links">{links}</div>
        )}
        {(playInRow || hasActions) && (
          <div className="ds-detail-actions">
            {playInRow && play}
            {actions}
          </div>
        )}
      </div>
    </header>
  )
}

/** Pushes the actions after it to the end of the header's action row. */
export function DetailActionsSpacer() {
  return <span className="ds-spacer" />
}
