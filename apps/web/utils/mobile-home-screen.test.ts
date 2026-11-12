import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import manifest from '../app/manifest'

test('home-screen launches use the existing session-aware root within app scope', () => {
  const app = manifest()
  assert.equal(app.name, 'NFS Media')
  assert.equal(app.short_name, app.name)
  assert.equal(app.id, '/')
  assert.equal(app.start_url, '/')
  assert.equal(app.scope, '/')
  assert.equal(app.display, 'standalone')
  assert.equal(app.theme_color, '#e9ecf0')
  assert.equal(app.background_color, app.theme_color)
})

test('manifest icons are local PNGs with the declared dimensions', async () => {
  const icons = manifest().icons
  assert.ok(icons)
  assert.deepEqual(
    icons.map((icon) => icon.sizes),
    ['192x192', '512x512'],
  )
  for (const icon of icons) {
    assert.equal(icon.type, 'image/png')
    assert.equal(icon.purpose, 'any')
    assert.match(icon.src, /^\/icons\/app\/icon-\d+\.png$/)
    const png = await readFile(new URL(`../public${icon.src}`, import.meta.url))
    assert.deepEqual(png.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'))
    assert.equal(png.toString('ascii', 12, 16), 'IHDR')
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes)
    assert.equal(png[25], 2, 'opaque RGB, without alpha')
  }
})

test('Apple touch icon is a local opaque 180px PNG', async () => {
  const png = await readFile(
    new URL('../public/icons/app/apple-touch-icon.png', import.meta.url),
  )
  assert.deepEqual(png.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'))
  assert.equal(png.readUInt32BE(16), 180)
  assert.equal(png.readUInt32BE(20), 180)
  assert.equal(png[25], 2, 'opaque RGB, without alpha')
})

test('root layout declares Apple metadata and an unobscured default status bar', async () => {
  const layout = await readFile(
    new URL('../app/layout.tsx', import.meta.url),
    'utf8',
  )
  assert.match(layout, /applicationName: 'NFS Media'/)
  assert.match(
    layout,
    /appleWebApp:\s*\{\s*capable: true,\s*title: 'NFS Media',\s*statusBarStyle: 'default'/,
  )
  assert.match(
    layout,
    /apple:\s*\{\s*url: '\/icons\/app\/apple-touch-icon\.png',\s*sizes: '180x180'/,
  )
  assert.match(
    layout,
    /export const viewport: Viewport = \{\s*themeColor: '#e9ecf0'/,
  )
  assert.doesNotMatch(layout, /viewportFit:|maximumScale:|userScalable:/)
})
