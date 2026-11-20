import { db } from '@/lib/db'
import { rebuildSpotifyTrackMatchAudit } from '@/services/spotify-track-match-audit'

rebuildSpotifyTrackMatchAudit()
  .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
  .catch(() => {
    process.stderr.write('Spotify match audit failed.\n')
    process.exitCode = 1
  })
  .finally(() => db.$client.end())
