'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LastfmSyncStatusSchema } from '@repo/schemas/lastfm'
import { Button } from '@repo/ui/components/ui/button'
import { fetchApiData } from '@/utils/api'
import { errorMessage, refreshScrobbleLinks } from './lastfm-sync'
import { useConfig } from './providers'

export default function LastfmTracksImport() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const status = useQuery({
    queryKey: ['lastfm-sync'],
    staleTime: 60_000,
    queryFn: () =>
      fetchApiData(apiBaseUrl, '/api/v1/lastfm/sync', LastfmSyncStatusSchema),
  })
  const importing = useMutation({
    mutationFn: () => refreshScrobbleLinks(apiBaseUrl, client),
  })
  if (!status.data?.configured || !status.data.storedScrobbles) return null
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={importing.isPending}
        title="Use stored scrobbles; no Last.fm requests."
        onClick={() => importing.mutate()}
      >
        {importing.isPending ? 'Importing...' : 'Import Last.fm tracks'}
      </Button>
      {importing.isError && (
        <span role="alert" className="text-sm">
          {errorMessage(importing.error, 'Could not import Last.fm tracks.')}
        </span>
      )}
    </>
  )
}
