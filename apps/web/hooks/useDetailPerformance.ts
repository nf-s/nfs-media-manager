'use client'

import {
  useDetailInspector,
  useInspectorPage,
} from '@/components/detail-inspector-context'
import { useBrowsePerformance } from './useBrowsePerformance'

export function useDetailPerformance(
  screen: 'tracks' | 'albums' | 'artists' | undefined,
  identity: string,
  query: { data: unknown; isError: boolean },
) {
  const inspector = useDetailInspector()
  const insideInspector = useInspectorPage() !== null
  useBrowsePerformance(
    screen,
    {
      identity,
      enabled: insideInspector || !inspector?.active,
      page: 1,
      scrollTop: 0,
      outcome:
        query.data !== undefined ? 'rows' : query.isError ? 'error' : undefined,
    },
    'detail',
  )
}
