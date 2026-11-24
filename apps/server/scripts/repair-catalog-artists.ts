import { db } from '@/lib/db'
import { repairMatchedTidalArtists } from '@/services/tidal-artist-reconciliation'
import {
  reconcileExactCatalogArtists,
  repairStoredSimilarArtists,
  repairScopedSpotifyCredits,
} from '@/services/catalog-artist-reconciliation'

async function main() {
  const [mode = '--dry-run', ...rest] = process.argv.slice(2)
  if (rest.length || !['--dry-run', '--apply'].includes(mode))
    throw new Error('Usage: repair:catalog-artists [--dry-run | --apply]')
  const apply = mode === '--apply'
  const exactProfiles = await reconcileExactCatalogArtists(apply)
  const matchedRecordings = await repairMatchedTidalArtists(apply)
  const similarArtists = await repairStoredSimilarArtists(apply)
  const scopedCredits = await repairScopedSpotifyCredits(apply)
  process.stdout.write(
    JSON.stringify({
      apply,
      exactProfiles,
      matchedRecordings,
      similarArtists,
      scopedCredits,
    }) + '\n',
  )
}

void main()
  .catch(() => {
    process.stderr.write('Catalog artist repair failed.\n')
    process.exitCode = 1
  })
  .finally(() => db.$client.end())
