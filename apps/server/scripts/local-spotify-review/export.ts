import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { db } from '@/lib/db'
import { readLocalSpotifyReview } from './read'
import { renderSpotifyReview } from './render'

async function main() {
  const { values } = parseArgs({
    options: { output: { type: 'string' }, 'owner-id': { type: 'string' } },
  })
  if (!values.output) {
    process.stderr.write('Supply --output with a new local HTML filename.\n')
    process.exitCode = 1
    return
  }
  const items = await readLocalSpotifyReview(values['owner-id'])
  const document = await renderSpotifyReview(items)
  await writeFile(resolve(values.output), document, { mode: 0o600, flag: 'wx' })
  process.stdout.write(
    JSON.stringify({
      tracks: items.length,
      candidates: items.reduce(
        (count, item) => count + item.candidates.length,
        0,
      ),
      preselected: items.filter((item) => item.assessment === 'likely').length,
    }) + '\n',
  )
}

main()
  .catch((error) => {
    const message =
      error instanceof Error &&
      error.message === 'Choose one search owner with --owner-id.'
        ? error.message
        : error instanceof Error && 'code' in error && error.code === 'EEXIST'
          ? 'That file already exists. Choose a new output filename.'
          : 'Could not write the local Spotify checklist.'
    process.stderr.write(message + '\n')
    process.exitCode = 1
  })
  .finally(() => db.$client.end())
