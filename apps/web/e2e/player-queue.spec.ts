import { expect, test, type Locator } from '@playwright/test'
import type { PlayableItem, SavedPlayback } from '@repo/schemas/playback'
import { PlaybackCatalogInputSchema } from '@repo/schemas/playback'
import { CatalogMembershipInputSchema } from '@repo/schemas/manual-add'
import { webOrigin } from './preview'

function item(
  kind: PlayableItem['kind'],
  index: number,
  label: string,
): PlayableItem {
  return {
    kind,
    uri: `spotify:${kind}:${String(index).padStart(22, '0')}`,
    title:
      `${label} with a very long title ${'that should fit on one line '.repeat(6)}`.trimEnd(),
    artist: 'Synthetic artist',
    albumId: null,
    albumTitle: '',
    artworkUrl: null,
    trackCount: kind === 'album' ? 12 : 1,
  }
}

function actionPosition(action: Locator) {
  return action.evaluate((button) => {
    const row = button.closest('.queue-row')?.getBoundingClientRect()
    if (!row) throw new Error('Queue control has no row')
    const bounds = button.getBoundingClientRect()
    return {
      x: bounds.left - row.left,
      y: bounds.top - row.top,
      width: bounds.width,
      height: bounds.height,
    }
  })
}

test('queue titles leave room for controls and saving clears the library action', async ({
  page,
  isMobile,
}) => {
  if (isMobile) await page.setViewportSize({ width: 320, height: 812 })
  const playing = item('track', 1, 'Playing track')
  const release = item('album', 2, 'Playing album')
  const queued = item('album', 3, 'Queued album')
  const savedAlbum = item('album', 4, 'Saved album')
  const upcoming = item('track', 5, 'Upcoming track')
  const savedTrack = item('track', 6, 'Saved track')
  const externalId = (entry: PlayableItem) => entry.uri.split(':').at(-1) ?? ''
  const saved = new Set([
    externalId(playing),
    externalId(savedAlbum),
    externalId(savedTrack),
  ])
  const state: SavedPlayback = {
    version: 1,
    savedAt: Date.now(),
    current: playing,
    currentFromSource: true,
    session: null,
    shuffle: false,
    sequence: 2,
    target: { kind: 'spotify', device: null, browser: null },
    queue: [queued, savedAlbum].map((entry, index) => ({
      key: `queue-${index}`,
      item: entry,
    })),
    snapshot: {
      trackUri: playing.uri,
      linkedFromUri: null,
      trackName: playing.title,
      artists: playing.artist,
      albumName: release.title,
      albumUri: release.uri,
      artistLinks: [
        {
          name: 'Synthetic artist',
          uri: 'spotify:artist:0000000000000000000007',
        },
      ],
      artworkUrl: null,
      durationMs: 200_000,
      positionMs: 50_000,
      paused: true,
      contextUri: release.uri,
      hasNext: true,
      trackNumber: 1,
      discNumber: 1,
      at: Date.now(),
    },
    source: {
      descriptor: { type: 'album', tracks: [playing, upcoming, savedTrack] },
      label: 'Fixture source',
      href: '/tracks',
      kind: 'album',
      length: 3,
      startIndex: 0,
      remaining: [[1, 3]],
      played: ['0:0'],
      skipped: [],
      exhausted: [],
      upcoming: [upcoming, savedTrack].map((entry, index) => ({
        index: index + 1,
        position: 0,
        item: entry,
      })),
      history: [],
    },
  }
  await page.route(
    /^https:\/\/(?:[^/]+\.spotify\.com|sdk\.scdn\.co)\//,
    (route) => route.abort(),
  )
  await page.route(`${webOrigin}/api/v1/**`, async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let data: unknown
    if (path.endsWith('/spotify/status')) {
      data = {
        configured: true,
        connected: true,
        expiresAt: null,
        scope: null,
        redirectUri: null,
        playback: true,
        playbackHistory: false,
        playlists: false,
        playlistChanges: false,
      }
    } else if (path.endsWith('/playback/session')) {
      data = {
        revision: 1,
        role: 'follower',
        driver: { clientId: 'synthetic-driver', name: 'Fixture browser' },
        changed: true,
        state,
      }
    } else if (path.endsWith('/playback/catalog')) {
      const { items } = PlaybackCatalogInputSchema.parse(request.postDataJSON())
      const reference = (id: string) => ({
        id: `catalog-${id}`,
        inLibrary: saved.has(id),
      })
      data = {
        items: items.map((entry) => ({
          kind: entry.kind,
          spotifyId: entry.spotifyId,
          item: reference(entry.spotifyId),
          album: entry.album?.spotifyId
            ? reference(entry.album.spotifyId)
            : null,
          artists: entry.artists.map(({ name }) => ({
            name,
            id: 'fixture-artist',
          })),
        })),
      }
    } else if (path.endsWith('/manual-add/membership')) {
      const { items } = CatalogMembershipInputSchema.parse(
        request.postDataJSON(),
      )
      data = {
        items: items.map((entry) => ({
          ...entry,
          ambiguous: false,
          mediaItemId: saved.has(entry.externalId)
            ? `catalog-${entry.externalId}`
            : null,
        })),
      }
    } else if (
      path.endsWith(`/catalog/media/catalog-${externalId(queued)}/add`)
    ) {
      const id = externalId(queued)
      expect(request.method()).toBe('POST')
      saved.add(id)
      data = { created: true, mediaItemId: `catalog-${id}` }
    } else if (path.endsWith('/spotify/playback/token')) {
      data = {
        accessToken: 'synthetic',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }
    } else {
      return route.fallback()
    }
    await route.fulfill({
      json: { statusCode: 200, message: 'OK', data },
    })
  })
  await page.goto('/tracks')
  if (isMobile) {
    await page
      .getByRole('button', { name: `Open player: ${playing.title}` })
      .click()
  } else {
    await page.getByRole('button', { name: /^Queue: 2 queued/ }).click()
  }

  const panel = page.locator('.queue-contents:visible')
  await expect(
    panel.getByRole('heading', { name: 'Next from Fixture source' }),
  ).toBeVisible()
  const rows = panel.locator('.queue-row')
  await expect(rows).toHaveCount(5)
  for (const row of await rows.all()) {
    const geometry = await row.evaluate((element) => {
      const text = element.querySelector('.player-text')
      const title = text?.querySelector('strong')
      const right = element.getBoundingClientRect().right
      const controls = [...element.querySelectorAll('button')].map((button) =>
        button.getBoundingClientRect(),
      )
      return {
        titleClipped:
          title instanceof HTMLElement && title.scrollWidth > title.clientWidth,
        titleAvailable: Boolean(title?.getAttribute('title')),
        rowInsideViewport: right <= window.innerWidth,
        textInsideRow: text && text.getBoundingClientRect().right <= right,
        controlsInsideRow: controls.every((control) => control.right <= right),
        titleClearOfControls:
          title &&
          controls.every(
            (control) => title.getBoundingClientRect().right <= control.left,
          ),
      }
    })
    expect(geometry).toEqual({
      titleClipped: true,
      titleAvailable: true,
      rowInsideViewport: true,
      textInsideRow: true,
      controlsInsideRow: true,
      titleClearOfControls: true,
    })
  }

  const playingRow = rows.nth(0)
  const queuedRow = rows.nth(1)
  const upcomingRow = rows.nth(3)
  for (const { name, href } of [
    { name: playing.title, href: `/tracks/catalog-${externalId(playing)}` },
    { name: release.title, href: `/albums/catalog-${externalId(release)}` },
    { name: 'Synthetic artist', href: '/artists/fixture-artist' },
  ]) {
    await expect(
      playingRow.getByRole('link', { name, exact: true }),
    ).toHaveAttribute('data-workspace-href', href)
  }
  await expect(
    playingRow.getByRole('button', { name: /^Add album to library/ }),
  ).toBeEnabled()
  await expect(
    upcomingRow.getByRole('button', { name: /^Add track to library/ }),
  ).toBeEnabled()
  await expect(
    panel.getByRole('button', { name: /is in your library/ }),
  ).toHaveCount(0)
  const add = queuedRow.getByRole('button', { name: /^Add album to library/ })
  await expect(add).toBeEnabled()
  const play = queuedRow.getByRole('button', {
    name: `Play ${queued.title} now`,
  })
  await queuedRow.scrollIntoViewIfNeeded()
  const before = await actionPosition(play)
  if (!isMobile) {
    const idleColor = await add.evaluate(
      (button) => getComputedStyle(button).color,
    )
    await expect(queuedRow.locator('.queue-actions')).toHaveCSS('opacity', '0')
    await add.hover()
    await expect(queuedRow.locator('.queue-actions')).toHaveCSS('opacity', '1')
    await expect(add).not.toHaveCSS('color', idleColor)
    expect(await actionPosition(play)).toEqual(before)
    await page.mouse.move(0, 0)
    await queuedRow.getByRole('link', { name: queued.title }).focus()
    await page.keyboard.press('Tab')
    await expect(add).toBeFocused()
    await expect(queuedRow.locator('.queue-actions')).toHaveCSS('opacity', '1')
    await expect(add).not.toHaveCSS('color', idleColor)
    await add.press('Enter')
  } else {
    await expect(queuedRow.locator('.queue-actions')).toHaveCSS('opacity', '1')
    await add.tap()
  }
  await expect(queuedRow.locator('.ds-library-action')).toHaveCount(0)
  const savedLink = queuedRow.getByRole('link', { name: queued.title })
  await expect(savedLink).toHaveAttribute(
    'data-workspace-href',
    `/albums/catalog-${externalId(queued)}`,
  )
  if (!isMobile) await expect(savedLink).toBeFocused()
  expect(await actionPosition(play)).toEqual(before)
  await expect(rows).toHaveCount(5)
})
