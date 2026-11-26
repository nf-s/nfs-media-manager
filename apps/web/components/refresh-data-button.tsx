'use client'

import { useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { ReadButton } from './read-button'
import { refreshClientQueries } from '@/utils/query-cache'

export default function RefreshDataButton() {
  const client = useQueryClient()

  return (
    <ReadButton
      variant="ghost"
      type="button"
      aria-label="Refresh cached data"
      title="Refresh cached data"
      loadingLabel="Refreshing…"
      loadedLabel="Refreshed"
      read={() => refreshClientQueries(client)}
    >
      <RefreshCw aria-hidden="true" className="ds-i" />
      <span className="hidden min-[701px]:inline">Refresh</span>
    </ReadButton>
  )
}
