import { useLayoutEffect } from 'react'
import { enterSignedInPage } from './bootstrap'

/**
 * Marks the page as signed in while the calling component is mounted, so the
 * device store may start. Call it only from a component behind the session
 * check. It is a hook rather than an element because an added element moves
 * the shell's place in the useId tree, and hydration that waits for part of
 * the page can then lose that place, so every id under the shell differs from
 * the server's. Its layout effect runs before the store's in `Providers`.
 */
export function useSignedInSession() {
  useLayoutEffect(() => enterSignedInPage(), [])
}
