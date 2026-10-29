'use client'

import { useEffect, useRef } from 'react'

export function useInfiniteTableScroll({
  enabled,
  fetchNextPage,
  resetKey,
}: {
  enabled: boolean
  fetchNextPage: (options: { cancelRefetch: boolean }) => Promise<unknown>
  resetKey: string
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [resetKey])

  useEffect(() => {
    if (
      !enabled ||
      !scroller.current ||
      !sentinel.current ||
      typeof IntersectionObserver === 'undefined'
    )
      return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          void fetchNextPage({ cancelRefetch: false })
      },
      { root: scroller.current, rootMargin: '300px' },
    )
    observer.observe(sentinel.current)
    return () => observer.disconnect()
  }, [enabled, fetchNextPage, resetKey])

  return { scroller, sentinel }
}
