import { lstat, readdir } from 'node:fs/promises'
import { resolve, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

async function walk(directory, inspect) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    inspect(path, entry)
    if (entry.isDirectory()) await walk(path, inspect)
  }
}

export async function assertPublicAssetsSafe(appDirectory) {
  const publicDirectory = resolve(appDirectory, 'public')
  if ((await lstat(publicDirectory)).isSymbolicLink()) {
    throw new Error('The public directory must not be a symlink')
  }
  await walk(publicDirectory, (path, entry) => {
    const name = relative(publicDirectory, path).replaceAll('\\', '/')
    if (
      name === 'data' ||
      name === 'config.json' ||
      name.endsWith('.map') ||
      entry.isSymbolicLink()
    ) {
      throw new Error(
        `Unsafe public build input: ${name}. Move it outside public before building.`,
      )
    }
  })
}

export async function assertCloudflareBuildSafe(appDirectory) {
  const outputDirectory = resolve(appDirectory, '.open-next')
  const assetsDirectory = resolve(outputDirectory, 'assets')
  for (const directory of [outputDirectory, assetsDirectory]) {
    if ((await lstat(directory)).isSymbolicLink()) {
      throw new Error('Cloudflare artifact directories must not be symlinks')
    }
  }
  await lstat(resolve(outputDirectory, 'worker.js'))
  await walk(assetsDirectory, (path, entry) => {
    const name = relative(assetsDirectory, path).replaceAll('\\', '/')
    if (
      name === 'data' ||
      name === 'config.json' ||
      name.endsWith('.map') ||
      entry.isSymbolicLink()
    ) {
      throw new Error(`Unsafe public Cloudflare artifact: ${name}`)
    }
  })
  await walk(outputDirectory, (path) => {
    const name = relative(outputDirectory, path).replaceAll('\\', '/')
    if (
      /(^|\/)public\/(data(\/|$)|config\.json$)/.test(name) ||
      /^\.env($|\.)/.test(basename(path))
    ) {
      throw new Error(`Private input included in Cloudflare artifact: ${name}`)
    }
  })
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await assertCloudflareBuildSafe(
    resolve(fileURLToPath(new URL('..', import.meta.url))),
  )
}
