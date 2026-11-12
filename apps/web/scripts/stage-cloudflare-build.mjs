import { constants } from 'node:fs'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import {
  assertCloudflareBuildSafe,
  assertPublicAssetsSafe,
} from './check-cloudflare-build.mjs'

const copyOptions = {
  recursive: true,
  verbatimSymlinks: true,
  // Clone files when supported; otherwise Node copies them without hard-linking.
  mode: constants.COPYFILE_FICLONE,
}

const excludedDirectories = new Set([
  'node_modules',
  '.git',
  '.next',
  '.open-next',
  '.wrangler',
  '.turbo',
  '.cloudflare',
  '.local-plugins',
  '.neon',
])

async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function copySource(source, destination, web = false) {
  await cp(source, destination, {
    ...copyOptions,
    filter: async (path) => {
      const name = basename(path)
      const local = relative(source, path).replaceAll('\\', '/')
      if (
        excludedDirectories.has(name) ||
        name.startsWith('.open-next-publish-') ||
        name.startsWith('.env') ||
        name.startsWith('.dev.vars') ||
        name === '.DS_Store' ||
        name.endsWith('.tsbuildinfo') ||
        (web &&
          (local === 'dist' ||
            local === 'public/data' ||
            local === 'public/config.json')) ||
        (web && local.startsWith('public/') && name.endsWith('.map'))
      )
        return false

      if ((await lstat(path)).isSymbolicLink()) {
        throw new Error(
          `Symlinked build source is not supported: ${local || name}`,
        )
      }
      return true
    },
  })
}

async function copyDependencies(source, destination) {
  if (await exists(source)) {
    await cp(source, destination, {
      ...copyOptions,
      filter: (path) => basename(path) !== '.cache',
    })
  }
}

async function stageWorkspace(workspace, destination) {
  for (const name of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.prettierrc',
  ]) {
    if (await exists(join(workspace, name))) {
      await copySource(join(workspace, name), join(destination, name))
    }
  }

  await mkdir(join(destination, 'apps'), { recursive: true })
  await copySource(
    join(workspace, 'apps/web'),
    join(destination, 'apps/web'),
    true,
  )
  await copyDependencies(
    join(workspace, 'node_modules'),
    join(destination, 'node_modules'),
  )
  await copyDependencies(
    join(workspace, 'apps/web/node_modules'),
    join(destination, 'apps/web/node_modules'),
  )

  await mkdir(join(destination, 'packages'))
  for (const entry of await readdir(join(workspace, 'packages'), {
    withFileTypes: true,
  })) {
    if (
      !entry.isDirectory() ||
      !(await exists(join(workspace, 'packages', entry.name, 'package.json')))
    )
      continue
    const source = join(workspace, 'packages', entry.name)
    const target = join(destination, 'packages', entry.name)
    await copySource(source, target)
    await copyDependencies(
      join(source, 'node_modules'),
      join(target, 'node_modules'),
    )
  }

  // The web workspace references API declarations, not its runtime or local data.
  for (const name of ['package.json', 'dist/types']) {
    const source = join(workspace, 'apps/server', name)
    if (await exists(source)) {
      await mkdir(join(destination, 'apps/server'), { recursive: true })
      await copySource(source, join(destination, 'apps/server', name))
    }
  }
}

async function publishBuild(stagedApp, appDirectory) {
  const publishDirectory = await mkdtemp(
    join(appDirectory, '.open-next-publish-'),
  )
  const output = join(appDirectory, '.open-next')
  const previous = join(publishDirectory, 'previous')
  let cleanup = true
  try {
    await cp(
      join(stagedApp, '.open-next'),
      join(publishDirectory, '.open-next'),
      copyOptions,
    )
    await assertCloudflareBuildSafe(publishDirectory)
    const hadPrevious = await exists(output)
    if (hadPrevious) await rename(output, previous)
    try {
      await rename(join(publishDirectory, '.open-next'), output)
    } catch (error) {
      if (hadPrevious) {
        try {
          await rename(previous, output)
        } catch (restoreError) {
          cleanup = false
          throw new AggregateError(
            [error, restoreError],
            `Previous build retained at ${previous}`,
          )
        }
      }
      throw error
    }
  } finally {
    if (cleanup) await rm(publishDirectory, { recursive: true, force: true })
  }
}

export async function buildInCleanWorkspace(appDirectory, build) {
  const workspace = resolve(appDirectory, '../..')
  const staging = await mkdtemp(join(tmpdir(), 'media-web-cloudflare-'))
  try {
    await stageWorkspace(workspace, staging)
    const stagedApp = join(staging, 'apps/web')
    await assertPublicAssetsSafe(stagedApp)
    await build(stagedApp)
    await assertCloudflareBuildSafe(stagedApp)
    await publishBuild(stagedApp, appDirectory)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
