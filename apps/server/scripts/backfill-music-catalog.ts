const args = process.argv.slice(2)
if (
  args.length > 1 ||
  (args[0] && args[0] !== '--dry-run' && args[0] !== '--apply')
) {
  process.stderr.write('Usage: backfill:music-catalog [--dry-run | --apply]\n')
  process.exitCode = 1
} else {
  const [{ db }, { backfillMusicCatalog }] = await Promise.all([
    import('@/lib/db'),
    import('@/services/music-catalog-backfill'),
  ])
  try {
    const counts = await backfillMusicCatalog(args[0] === '--apply')
    process.stdout.write(JSON.stringify(counts, null, 2) + '\n')
  } catch {
    process.stderr.write('Music catalog backfill failed.\n')
    process.exitCode = 1
  } finally {
    await db.$client.end()
  }
}
