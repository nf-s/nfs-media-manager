'use client'

import { createContext, useCallback, useContext, type RefObject } from 'react'
import { locationHref, type WorkspaceTab } from '@/utils/workspace-tabs'

/** An empty query on a restored Browse tab is an explicit part of its snapshot. */
export const WorkspaceBrowseNavigation = createContext<{
  restored: RefObject<WorkspaceTab | null>
  replace: (href: string) => void
}>({
  restored: { current: null },
  replace: (href) => window.history.replaceState(null, '', href),
})

export function useRestoreBrowsePreferences() {
  const navigation = useContext(WorkspaceBrowseNavigation)
  return useCallback(
    (href: string) => {
      if (
        !window.location.search &&
        navigation.restored.current?.href !== locationHref()
      )
        navigation.replace(href)
    },
    [navigation],
  )
}
