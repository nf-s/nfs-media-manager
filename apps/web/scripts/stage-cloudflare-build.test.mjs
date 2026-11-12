import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { buildInCleanWorkspace } from './stage-cloudflare-build.mjs'
import { assertCloudflareBuildSafe } from './check-cloudflare-build.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'media-stage-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const app = join(root, 'apps/web')
  const files = {
    'package.json': '{}',
    'pnpm-workspace.yaml': 'packages: [apps/*, packages/*]',
    '.env': 'PRIVATE_ROOT=synthetic',
    '.npmrc': 'PRIVATE_NPM_TOKEN=synthetic',
    'apps/web/package.json': '{}',
    'apps/web/app/page.tsx': 'export default function Page() {}',
    'apps/web/public/data/library.json': 'synthetic library',
    'apps/web/public/config.json': 'synthetic private config',
    'apps/web/public/chunk.js.map': 'synthetic source map',
    'apps/web/public/icons/icon.svg': '<svg/>',
    'apps/web/.env.local': 'PRIVATE_WEB=synthetic',
    'apps/web/.dev.vars': 'PRIVATE_WORKER=synthetic',
    'apps/web/.next/local-dev': 'preserve development output',
    'apps/web/dist/old.js': 'stale output',
    'apps/server/package.json': '{}',
    'apps/server/dist/types/src/app.d.ts': 'export type App = string',
    'apps/server/src/private.ts': 'private runtime',
    'apps/server/data/library.json': 'private server library',
    'packages/schemas/package.json': '{}',
    'packages/schemas/dist/index.js': 'export const schema = {}',
    'packages/schemas/.env': 'PRIVATE_PACKAGE=synthetic',
    'node_modules/.pnpm/example/index.js': 'dependency original',
    'node_modules/.cache/private': 'cache excluded',
    'apps/web/.open-next/worker.js': 'previous worker',
    'apps/web/.open-next/assets/stale.js': 'previous asset',
  }
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
  await mkdir(join(app, 'node_modules'))
  await symlink(
    '../../../node_modules/.pnpm/example',
    join(app, 'node_modules/example'),
  )
  return { root, app }
}

async function fakeBuild(app) {
  await mkdir(join(app, '.open-next/assets'), { recursive: true })
  await writeFile(join(app, '.open-next/worker.js'), 'new worker')
  await writeFile(join(app, '.open-next/assets/new.js'), 'new asset')
}

test('stages clean sources and independent dependencies without changing local private inputs', async (t) => {
  const { root, app } = await fixture(t)
  const privateFile = join(app, 'public/data/library.json')
  const before = await stat(privateFile)
  let stagedDirectory = ''
  await buildInCleanWorkspace(app, async (stagedApp) => {
    stagedDirectory = resolve(stagedApp, '../..')
    for (const excluded of [
      '.env',
      '.npmrc',
      'apps/web/.env.local',
      'apps/web/.dev.vars',
      'apps/web/public/data',
      'apps/web/public/config.json',
      'apps/web/public/chunk.js.map',
      'apps/web/.next',
      'apps/web/.open-next',
      'apps/web/dist',
      'apps/server/src',
      'apps/server/data',
      'packages/schemas/.env',
      'node_modules/.cache',
    ]) {
      await assert.rejects(stat(join(stagedDirectory, excluded)), {
        code: 'ENOENT',
      })
    }
    assert.equal(
      await readFile(join(stagedApp, 'public/icons/icon.svg'), 'utf8'),
      '<svg/>',
    )
    assert.equal(
      await readFile(
        join(stagedDirectory, 'packages/schemas/dist/index.js'),
        'utf8',
      ),
      'export const schema = {}',
    )
    assert.equal(
      await readFile(join(stagedApp, 'node_modules/example/index.js'), 'utf8'),
      'dependency original',
    )
    await writeFile(
      join(stagedApp, 'node_modules/example/index.js'),
      'dependency staged',
    )
    assert.equal(
      await readFile(join(root, 'node_modules/.pnpm/example/index.js'), 'utf8'),
      'dependency original',
    )
    await fakeBuild(stagedApp)
  })
  await assert.rejects(stat(stagedDirectory), { code: 'ENOENT' })
  assert.equal(await readFile(privateFile, 'utf8'), 'synthetic library')
  assert.equal((await stat(privateFile)).mtimeMs, before.mtimeMs)
  assert.equal(
    await readFile(join(app, 'public/config.json'), 'utf8'),
    'synthetic private config',
  )
  assert.equal(
    await readFile(join(app, '.next/local-dev'), 'utf8'),
    'preserve development output',
  )
  assert.equal(
    await readFile(join(app, '.open-next/worker.js'), 'utf8'),
    'new worker',
  )
  await assert.rejects(stat(join(app, '.open-next/assets/stale.js')), {
    code: 'ENOENT',
  })
  await assertCloudflareBuildSafe(app)
  assert.equal(
    (await readdir(app)).some((name) => name.startsWith('.open-next-publish-')),
    false,
  )
})

test('failed builds clean up staging and preserve the previous deployment output', async (t) => {
  const { app } = await fixture(t)
  let stagedDirectory = ''
  await assert.rejects(
    buildInCleanWorkspace(app, async (stagedApp) => {
      stagedDirectory = resolve(stagedApp, '../..')
      await fakeBuild(stagedApp)
      throw new Error('synthetic build failure')
    }),
    /synthetic build failure/,
  )
  await assert.rejects(stat(stagedDirectory), { code: 'ENOENT' })
  assert.equal(
    await readFile(join(app, '.open-next/worker.js'), 'utf8'),
    'previous worker',
  )
})

test('unsafe generated output is never published', async (t) => {
  const { app } = await fixture(t)
  await assert.rejects(
    buildInCleanWorkspace(app, async (stagedApp) => {
      await fakeBuild(stagedApp)
      await writeFile(
        join(stagedApp, '.open-next/assets/config.json'),
        'synthetic secret',
      )
    }),
    /Unsafe public Cloudflare artifact/,
  )
  assert.equal(
    await readFile(join(app, '.open-next/worker.js'), 'utf8'),
    'previous worker',
  )
})

test('public symlinks cannot bring excluded inputs back into the build', async (t) => {
  const { app } = await fixture(t)
  await symlink('data/library.json', join(app, 'public/alias.json'))
  await assert.rejects(
    buildInCleanWorkspace(app, async () => {
      assert.fail('unsafe sources must be rejected before compiling')
    }),
    /Symlinked build source/,
  )
  assert.equal(
    await readFile(join(app, '.open-next/worker.js'), 'utf8'),
    'previous worker',
  )
})
