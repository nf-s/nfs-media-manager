import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

/**
 * The one header for every item: artwork, kind, title, creator, one line of
 * facts, then actions. The title is 18px in the drawer and 22px on a
 * standalone page (inside `.ds-page`). Actions start with the play pair where
 * the item can be played.
 */
export function DetailHeader({
  art,
  kind,
  title,
  by,
  facts = [],
  actions,
  headingLevel = 2,
  className,
}: {
  art?: ReactNode
  kind: string
  title: ReactNode
  by?: ReactNode
  facts?: readonly ReactNode[]
  actions?: ReactNode
  headingLevel?: 1 | 2
  className?: string
}) {
  const Heading = headingLevel === 1 ? 'h1' : 'h2'
  const shown = facts.filter(
    (fact) => fact != null && fact !== false && fact !== '',
  )
  return (
    <header
      className={cn('ds-detail-head', className)}
      data-art={art ? undefined : 'none'}
    >
      {art}
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
        {actions != null && actions !== false && (
          <div className="ds-detail-actions">{actions}</div>
        )}
      </div>
    </header>
  )
}

/** Pushes the actions after it to the end of the header's action row. */
export function DetailActionsSpacer() {
  return <span className="ds-spacer" />
}
