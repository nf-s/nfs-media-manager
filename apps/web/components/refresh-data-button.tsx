'use client'

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
import { refreshClientQueries } from '@/utils/query-cache'

export default function RefreshDataButton() {
  const client = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)

  async function refresh() {
    setRefreshing(true)
    try {
      await refreshClientQueries(client)
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      className="gap-1.5"
      aria-label="Refresh cached data"
      title="Refresh cached data"
      aria-busy={refreshing}
      disabled={refreshing}
      onClick={() => void refresh()}
    >
      <RefreshCw
        size={14}
        aria-hidden="true"
        className={refreshing ? 'animate-spin motion-reduce:animate-none' : ''}
      />
      <span className="hidden min-[701px]:inline">Refresh</span>
    </Button>
  )
}
