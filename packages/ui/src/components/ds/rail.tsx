import type { ReactNode } from 'react'

/**
 * An open saved view's name, cut with an ellipsis, followed by "Changed"
 * while the view differs from the saved one.
 */
export function ViewName({
  name,
  changed = false,
}: {
  name: string
  changed?: boolean
}) {
  return (
    <span className="ds-view-name">
      <span title={name}>{name}</span>
      {changed && <span className="ds-muted">Changed</span>}
    </span>
  )
}

/** The open saved view in the rail: its heading, then its name. */
export function RailView({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <>
      <h2 className="ds-rail-label">{label}</h2>
      <div className="ds-rail-view">{children}</div>
    </>
  )
}

/** Actions on the view under the rail's filters, in extra-small buttons. */
export function RailActions({ children }: { children: ReactNode }) {
  return <div className="ds-rail-actions">{children}</div>
}
