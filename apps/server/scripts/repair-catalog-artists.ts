import { db } from '@/lib/db'
import { repairMatchedTidalArtists } from '@/services/tidal-artist-reconciliation'
import { repairLibrarySpotifyArtists } from '@/services/catalog-artist-identities'
import { repairShadowTrackDetails } from '@/services/shadow-track-repair'
import {
  reconcileExactCatalogArtists,
  repairStoredSimilarArtists,
  repairScopedSpotifyCredits,
} from '@/services/catalog-artist-reconciliation'

async function main() {
  const [mode = '--dry-run', family = 'all', ...rest] = process.argv.slice(2)
  const repairs = new Map([
    ['exactProfiles', reconcileExactCatalogArtists],
    ['librarySpotifyArtists', repairLibrarySpotifyArtists],
    ['scopedCredits', repairScopedSpotifyCredits],
    ['matchedRecordings', repairMatchedTidalArtists],
    ['similarArtists', repairStoredSimilarArtists],
  ])
  if (
    rest.length ||
    !['--dry-run', '--apply'].includes(mode) ||
    (family !== 'all' && family !== 'shadowTracks' && !repairs.has(family))
  )
    throw new Error(
      'Usage: repair:catalog-artists [--dry-run | --apply] [family]',
    )
  const apply = mode === '--apply'
  for (const [name, repair] of repairs)
    if (family === 'all' || family === name)
      process.stdout.write(
        JSON.stringify({ apply, [name]: await repair(apply, db) }) + '\n',
      )
  if (family === 'all' || family === 'shadowTracks')
    process.stdout.write(
      JSON.stringify({
        apply,
        shadowTracks: await repairShadowTrackDetails(apply, db),
      }) + '\n',
    )
}

void main()
  .catch(() => {
    process.stderr.write('Catalog artist repair failed.\n')
    process.exitCode = 1
  })
  .finally(() => db.$client.end())
