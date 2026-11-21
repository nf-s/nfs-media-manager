import type { ReactNode, Ref } from 'react'

/** Inside a detail, the rows and the selection bar under them share the list's room. */
export function DetailListFrame({
  framed,
  frame,
  children,
}: {
  framed: boolean
  frame: Ref<HTMLDivElement>
  children: ReactNode
}) {
  return framed ? (
    <div ref={frame} className="dtl-browse-frame">
      {children}
    </div>
  ) : (
    <>{children}</>
  )
}
