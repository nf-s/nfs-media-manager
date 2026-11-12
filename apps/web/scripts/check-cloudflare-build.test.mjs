import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  assertCloudflareBuildSafe,
  assertPublicAssetsSafe,
} from './check-cloudflare-build.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'media-web-build-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'public'))
  await mkdir(join(directory, '.open-next/assets'), { recursive: true })
  await writeFile(join(directory, '.open-next/worker.js'), 'export default {}')
  return directory
}

test('clean public assets and build output pass', async (t) => {
  const directory = await fixture(t)
  await writeFile(join(directory, 'public/icon.svg'), '<svg/>')
  await assertCloudflareBuildSafe(directory)
})

for (const name of ['data', 'config.json', 'client.js.map']) {
  test(`rejects private public input ${name} without deleting it`, async (t) => {
    const directory = await fixture(t)
    await writeFile(join(directory, 'public', name), 'synthetic')
    await assert.rejects(
      assertPublicAssetsSafe(directory),
      /Unsafe public build input/,
    )
  })
  test(`rejects unsafe generated asset ${name}`, async (t) => {
    const directory = await fixture(t)
    await writeFile(join(directory, '.open-next/assets', name), 'synthetic')
    await assert.rejects(
      assertCloudflareBuildSafe(directory),
      /Unsafe public Cloudflare artifact/,
    )
  })
}

test('rejects symlinked public assets', async (t) => {
  const directory = await fixture(t)
  await symlink(join(directory, '.open-next'), join(directory, 'public/linked'))
  await assert.rejects(
    assertPublicAssetsSafe(directory),
    /Unsafe public build input/,
  )
})

test('rejects dotenv files in server artifacts', async (t) => {
  const directory = await fixture(t)
  await writeFile(join(directory, '.open-next/.env'), 'SYNTHETIC=true')
  await assert.rejects(
    assertCloudflareBuildSafe(directory),
    /Private input included/,
  )
})
