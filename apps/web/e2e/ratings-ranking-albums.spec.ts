import { expect, test } from '@playwright/test'
import { RatingsRankingPageSchema } from '@repo/schemas/ratings-explorer'
import { PlaybackSyncInputSchema } from '@repo/schemas/playback'
import { albumSpotifyUri } from '../utils/album-links'
import { webOrigin } from './preview'

test('album ranking keeps the identity visible and uses page evidence and playback data', async ({
  page,
}) => {
  const reads: string[] = []
  let connected = false
  await page.addInitScript(() => {
    class FixturePlayer {
      private listeners = new Map<string, (payload: unknown) => void>()
      addListener(event: string, listener: (payload: unknown) => void) {
        this.listeners.set(event, listener)
        return true
      }
      async connect() {
        this.listeners.get('ready')?.({ device_id: 'fixture-browser' })
        return true
      }
      async getCurrentState() {
        return null
      }
      async activateElement() {}
      disconnect() {}
    }
    Object.defineProperty(window, 'Spotify', {
      value: { Player: FixturePlayer },
    })
  })
  await page.route('**/api/v1/spotify/status', (route) =>
    route.fulfill({
      json: {
        statusCode: 200,
        message: 'OK',
        data: {
          configured: true,
          connected,
          expiresAt: null,
          scope: null,
          redirectUri: null,
          playback: connected,
          playbackHistory: false,
          playlists: false,
          playlistChanges: false,
        },
      },
    }),
  )
  await page.route('**/api/v1/spotify/playback/token', (route) =>
    route.fulfill({
      json: {
        statusCode: 200,
        message: 'OK',
        data: {
          accessToken: 'synthetic',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    }),
  )
  let revision = 0
  const queued = new Set<string>()
  await page.route('**/api/v1/playback/session', async (route) => {
    const body = PlaybackSyncInputSchema.parse(route.request().postDataJSON())
    if (body.state !== undefined && body.revision === revision) {
      revision++
      for (const entry of body.state?.queue ?? []) queued.add(entry.item.uri)
    }
    await route.fulfill({
      json: {
        statusCode: 200,
        message: 'OK',
        data: {
          revision,
          role: 'driver',
          driver: { clientId: body.clientId, name: body.clientName },
          changed: false,
          state: null,
        },
      },
    })
  })
  const played: string[] = []
  await page.route('https://api.spotify.com/v1/**', async (route) => {
    const request = route.request()
    if (
      new URL(request.url()).pathname === '/v1/me/player/play' &&
      request.method() === 'PUT'
    ) {
      played.push(request.postDataJSON().context_uri)
      await route.fulfill({ status: 204 })
    } else if (request.method() === 'GET')
      await route.fulfill({ status: 200, json: { devices: [] } })
    else await route.fulfill({ status: 204 })
  })
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname
    if (
      path.startsWith('/api/v1/ratings/') ||
      /^\/api\/v1\/(albums|artists)\/[^/]+/.test(path)
    )
      reads.push(path)
  })
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/v1/ratings/ranking')),
    page.goto('/albums/ratings'),
  ])
  const pageData = RatingsRankingPageSchema.parse((await response.json()).data)
  const album = pageData.rows.find(
    (row) => row.album && albumSpotifyUri(row.album),
  )
  if (!album?.album) throw new Error('Expected a rated, playable preview album')
  const expectedUri = albumSpotifyUri(album.album)
  const table = page.getByRole('table', { name: 'Album rankings' })
  const row = table
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: album.title, exact: true }) })
    .first()
  const identity = row.getByRole('cell').first()
  const play = row.getByRole('button', {
    name: 'Play ' + album.title,
  })
  const queue = row.getByRole('button', {
    name: 'Add ' + album.title + ' to queue',
  })
  await identity.hover()
  await expect(play).toBeDisabled()
  await expect(queue).toBeDisabled()
  await expect(identity.locator('.ds-thumb')).toBeVisible()
  expect(await identity.locator('a').count()).toBeGreaterThanOrEqual(3)
  const initial = await identity.boundingBox()
  await table.evaluate((t) => t.parentElement?.scrollTo({ left: 400 }))
  await expect
    .poll(() => table.evaluate((t) => t.parentElement?.scrollLeft))
    .toBeGreaterThan(0)
  const scrolled = await identity.boundingBox()
  expect(scrolled?.x).toBe(initial?.x)
  await row
    .getByRole('button', {
      name: 'Combined score calculation for ' + album.title,
    })
    .click()
  await expect(
    page.getByLabel('Rating calculation', { exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Close calculation' }).click()
  expect(reads).toEqual(['/api/v1/ratings/ranking'])

  connected = true
  await page.reload()
  await identity.hover()
  await expect(play).toBeEnabled()
  await expect(queue).toBeEnabled()
  await queue.click()
  await expect.poll(() => queued.has(expectedUri ?? '')).toBe(true)
  await play.click()
  await expect.poll(() => played).toEqual([expectedUri])
  expect(reads).toEqual(['/api/v1/ratings/ranking', '/api/v1/ratings/ranking'])

  await identity.getByRole('link', { name: album.title, exact: true }).click()
  await expect
    .poll(() => reads.some((path) => path === '/api/v1/albums/' + album.id))
    .toBe(true)
  expect(new URL(page.url()).origin).toBe(webOrigin)
})
