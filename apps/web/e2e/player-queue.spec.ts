import { expect, test, type Locator, type Page } from '@playwright/test'
import type { PlayableItem, SavedPlayback } from '@repo/schemas/playback'
import { PlaybackCatalogInputSchema } from '@repo/schemas/playback'
import { CatalogMembershipInputSchema } from '@repo/schemas/manual-add'
import { webOrigin } from './preview'

const externalId = (entry: PlayableItem) => entry.uri.split(':').at(-1) ?? ''

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

async function mockPlayback(
  page: Page,
  state: SavedPlayback,
  saved: Set<string>,
  {
    promoting,
    shadowed,
    membershipReady,
    useCatalogServer = false,
  }: {
    promoting?: PlayableItem
    shadowed?: readonly PlayableItem[]
    membershipReady?: Promise<void>
    useCatalogServer?: boolean
  } = {},
) {
  const writes: string[] = []
  const promotions: string[] = []
  const observed = new Set<string>()
  const outsideIds = new Set(shadowed?.map(externalId))
  await page.route(
    /^https:\/\/(?:[^/]+\.spotify\.com|sdk\.scdn\.co)\//,
    (route) => {
      const { hostname, pathname } = new URL(route.request().url())
      if (hostname === 'api.spotify.com' && route.request().method() !== 'GET')
        writes.push(pathname)
      return route.abort()
    },
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
      if (useCatalogServer) return route.fallback()
      const { items } = PlaybackCatalogInputSchema.parse(request.postDataJSON())
      const reference = (id: string) => ({
        id: outsideIds.has(id) ? `outside-${id}` : `catalog-${id}`,
        inLibrary: saved.has(id) && !outsideIds.has(id),
      })
      for (const entry of items) observed.add(entry.spotifyId)
      data = {
        items: items.map((entry) => ({
          kind: entry.kind,
          spotifyId: entry.spotifyId,
          item: reference(entry.spotifyId),
          album: entry.album?.spotifyId
            ? reference(entry.album.spotifyId)
            : null,
          artists: entry.artists.flatMap(({ name, spotifyId }) =>
            spotifyId ? [{ name, id: 'fixture-artist', spotifyId }] : [],
          ),
        })),
      }
    } else if (path.endsWith('/manual-add/membership')) {
      await membershipReady
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
    } else if (/\/catalog\/media\/[^/]+\/add$/.test(path)) {
      if (!promoting) throw new Error('Unexpected catalog promotion')
      const id = externalId(promoting)
      expect(path).toBe(`/api/v1/catalog/media/catalog-${id}/add`)
      expect(request.method()).toBe('POST')
      promotions.push(id)
      saved.add(id)
      data = { created: true, mediaItemId: `catalog-${id}` }
    } else if (path.endsWith('/manual-add/add')) {
      throw new Error(
        'The observed catalog item should be promoted by its media ID',
      )
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
  return { writes, promotions, observed }
}

function snapshot(playing: PlayableItem, release: PlayableItem) {
  return {
    trackUri: playing.uri,
    linkedFromUri: null,
    trackName: playing.title,
    artists: playing.artist,
    albumName: release.title,
    albumUri: release.uri,
    artistLinks: [
      { name: playing.artist, uri: 'spotify:artist:0000000000000000000009' },
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
  }
}

function playback(current: PlayableItem): SavedPlayback {
  return {
    version: 1,
    savedAt: Date.now(),
    current,
    currentFromSource: true,
    session: null,
    shuffle: false,
    sequence: 2,
    target: { kind: 'spotify', device: null, browser: null },
    queue: [],
    snapshot: null,
    source: null,
  }
}

function openQueue(page: Page, isMobile: boolean, playing: PlayableItem) {
  return isMobile
    ? page
        .getByRole('button', { name: `Open player: ${playing.title}` })
        .click()
    : page.getByRole('button', { name: /^Queue: 2 queued/ }).click()
}

const savedActionName = /is in your library/

test('playback opens the shadow recording with its album, artwork and artist', async ({
  page,
  isMobile,
}) => {
  const release = {
    ...item('album', 81, 'Album'),
    title: 'Playback-only album',
  }
  const playing = {
    ...item('track', 82, 'Recording'),
    title: 'Playback-only recording',
    artist: 'Playback-only artist',
    albumTitle: release.title,
    albumUri: release.uri,
  }
  const artworkUrl = 'https://i.scdn.co/image/playback-fixture'
  await page.route(artworkUrl, (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#667788"/></svg>',
    }),
  )
  await mockPlayback(
    page,
    {
      ...playback(playing),
      snapshot: {
        ...snapshot(playing, release),
        albumUri: null,
        artworkUrl,
      },
    },
    new Set(),
    { useCatalogServer: true },
  )
  async function nowPlaying() {
    await page.goto('/tracks')
    if (isMobile)
      await page
        .getByRole('button', { name: `Open player: ${playing.title}` })
        .click()
    return page.locator(
      isMobile ? '.player-sheet-body > .player-text' : '.player-now',
    )
  }

  const dock = await nowPlaying()
  const title = dock.getByRole('link', { name: playing.title, exact: true })
  await expect(title).toHaveAttribute('data-workspace-href', /^\/tracks\//)
  await title.click()
  const detail = page.locator('.dtl-detail > header').last()
  await expect(
    detail.getByRole('heading', { name: playing.title }),
  ).toBeVisible()
  await expect(detail.getByRole('link', { name: release.title })).toBeVisible()
  await expect(detail.locator('img.ds-artimg')).toHaveAttribute(
    'src',
    artworkUrl,
  )
  await expect(detail.locator('img.ds-artimg')).toBeVisible()

  const artist = (await nowPlaying()).getByRole('link', {
    name: playing.artist,
    exact: true,
  })
  await expect(artist).toHaveAttribute('data-workspace-href', /^\/artists\//)
  await artist.click()
  await expect(
    page.getByRole('heading', { name: playing.artist }),
  ).toBeVisible()
})

test('queue titles leave room for controls and saving clears the library action', async ({
  page,
  isMobile,
}) => {
  if (isMobile) await page.setViewportSize({ width: 320, height: 812 })
  const playing = item('track', 1, 'Playing track')
  const relinked = item('track', 7, 'Relinked recording')
  const release = item('album', 2, 'Playing album')
  const queued = item('album', 3, 'Queued album')
  const savedAlbum = item('album', 4, 'Saved album')
  const upcoming = item('track', 5, 'Upcoming track')
  const savedTrack = item('track', 6, 'Saved track')
  const stale = { ...item('track', 8, 'Previous track'), trackId: 'previous' }
  const state: SavedPlayback = {
    ...playback(stale),
    queue: [queued, savedAlbum].map((entry, index) => ({
      key: `queue-${index}`,
      item: entry,
    })),
    snapshot: {
      ...snapshot(playing, release),
      trackUri: relinked.uri,
      relinkedTrackUri: playing.uri,
    },
    source: {
      descriptor: { type: 'album', tracks: [stale, upcoming, savedTrack] },
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
  const saved = new Set([
    externalId(playing),
    externalId(savedAlbum),
    externalId(savedTrack),
  ])
  let resolveMembership = () => {}
  const membershipReady = new Promise<void>((resolve) => {
    resolveMembership = resolve
  })
  const { writes, promotions, observed } = await mockPlayback(
    page,
    state,
    saved,
    {
      membershipReady,
      promoting: queued,
      shadowed: [playing, relinked],
    },
  )
  await page.goto('/tracks')
  await openQueue(page, isMobile, playing)
  const dock = page.locator('.player-dock')
  const nowPlaying = isMobile
    ? page.locator('.player-sheet-body > .player-text')
    : dock.locator('.player-text').first()
  await expect(
    nowPlaying.getByText(playing.title, { exact: true }),
  ).toBeVisible()
  const dockNowPlaying = dock.locator('.player-now')
  await expect(dockNowPlaying.locator('.ds-library-action')).toHaveCount(0)
  await expect(nowPlaying.locator('.ds-library-action')).toHaveCount(0)
  resolveMembership()
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
  const queuedArtist = queuedRow.getByRole('link', {
    name: queued.artist,
    exact: true,
  })
  await expect(queuedArtist).toHaveAttribute(
    'href',
    /^\/artists\?libraryScope=all&filters=/,
  )
  await expect(
    upcomingRow.getByRole('link', { name: upcoming.artist, exact: true }),
  ).toHaveAttribute('href', /^\/artists\?libraryScope=all&filters=/)
  for (const { name, href } of [
    { name: playing.title, href: `/tracks/catalog-${externalId(playing)}` },
    { name: release.title, href: `/albums/catalog-${externalId(release)}` },
    { name: 'Synthetic artist', href: '/artists/fixture-artist' },
  ]) {
    await expect(
      playingRow.getByRole('link', { name, exact: true }),
    ).toHaveAttribute('data-workspace-href', href)
  }
  const playingLink = nowPlaying.getByRole('link', { name: playing.title })
  await expect(playingLink).toHaveAttribute(
    'data-workspace-href',
    `/tracks/catalog-${externalId(playing)}`,
  )
  await expect(dock.getByRole('button', { name: savedActionName })).toHaveCount(
    0,
  )
  await expect(
    nowPlaying
      .locator('.player-identity-line')
      .first()
      .locator('.ds-library-action'),
  ).toHaveCount(0)
  if (isMobile)
    await expect(dockNowPlaying.locator('.ds-library-action')).toHaveCount(0)
  await expect(
    nowPlaying.getByRole('button', {
      name: `Add album to library · ${release.title}`,
    }),
  ).toBeEnabled()
  expect(
    [...observed].some((id) =>
      [playing, relinked].map(externalId).includes(id),
    ),
  ).toBe(true)
  await expect(
    playingRow.getByRole('button', { name: /^Add album to library/ }),
  ).toBeEnabled()
  await expect(
    upcomingRow.getByRole('button', { name: /^Add track to library/ }),
  ).toBeEnabled()
  await expect(
    panel.getByRole('button', { name: savedActionName }),
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
    await expect(queuedArtist).toBeFocused()
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
  await expect(
    page.getByRole('status').filter({
      hasText: `Added album to library · ${queued.title}`,
    }),
  ).toHaveAttribute('aria-atomic', 'true')
  const savedLink = queuedRow.getByRole('link', { name: queued.title })
  await expect(savedLink).toHaveAttribute(
    'data-workspace-href',
    `/albums/catalog-${externalId(queued)}`,
  )
  if (!isMobile) await expect(savedLink).toBeFocused()
  expect(await actionPosition(play)).toEqual(before)
  await expect(rows).toHaveCount(5)
  if (isMobile) {
    await page.getByRole('button', { name: 'Close player' }).click()
  } else {
    await dock.getByRole('button', { name: /^Queue: 2 queued/ }).click()
  }
  await openQueue(page, isMobile, playing)
  await expect(savedLink).toBeVisible()
  await expect(queuedRow.locator('.ds-library-action')).toHaveCount(0)
  await page.reload()
  await openQueue(page, isMobile, playing)
  await expect(savedLink).toHaveAttribute(
    'data-workspace-href',
    `/albums/catalog-${externalId(queued)}`,
  )
  await expect(queuedRow.locator('.ds-library-action')).toHaveCount(0)
  await expect(rows).toHaveCount(5)
  await playingRow
    .getByRole('link', { name: release.title, exact: true })
    .click()
  await expect(page).toHaveURL((url) =>
    Boolean(
      url.searchParams
        .get('inspect')
        ?.includes(`catalog-${externalId(release)}`),
    ),
  )
  expect(promotions).toEqual([externalId(queued)])
  expect(writes).toEqual([])
})

test('saving the playing recording preserves independent album navigation', async ({
  page,
  isMobile,
}) => {
  const playing = item('track', 11, 'Device track')
  const release = item('album', 12, 'Saved device album')
  const state: SavedPlayback = {
    ...playback(item('album', 13, 'Previous album')),
    snapshot: snapshot(playing, release),
  }
  const saved = new Set([externalId(release)])
  const { writes, promotions } = await mockPlayback(page, state, saved, {
    promoting: playing,
  })
  await page.goto('/tracks')
  const dock = page.locator('.player-dock')
  const dockNowPlaying = dock.locator('.player-now')
  const sheet = page.locator('.player-sheet-body')
  const miniPlayer = dock.getByRole('button', {
    name: `Open player: ${playing.title}`,
  })
  const addName = `Add track to library · ${playing.title}`
  const add = dockNowPlaying.getByRole('button', { name: addName })
  await expect(add).toBeEnabled()
  if (isMobile) {
    await miniPlayer.click()
    await expect(
      sheet.getByRole('button', { name: addName }).first(),
    ).toBeEnabled()
    await expect(
      sheet.locator('.player-text').first().getByRole('link', {
        name: release.title,
      }),
    ).toHaveAttribute(
      'data-workspace-href',
      `/albums/catalog-${externalId(release)}`,
    )
    await page.getByRole('button', { name: 'Close player' }).click()
  } else {
    await expect(
      dockNowPlaying.getByRole('link', {
        name: release.title,
        exact: true,
      }),
    ).toHaveAttribute(
      'data-workspace-href',
      `/albums/catalog-${externalId(release)}`,
    )
  }
  await expect(dockNowPlaying.locator('.ds-library-action')).toHaveCount(1)
  await add.press('Enter')
  await expect(
    page.getByRole('status').filter({
      hasText: `Added track to library · ${playing.title}`,
    }),
  ).toHaveAttribute('aria-atomic', 'true')
  await expect(dockNowPlaying.locator('.ds-library-action')).toHaveCount(0)
  if (isMobile) {
    await expect(miniPlayer).toBeFocused()
    await miniPlayer.click()
    await expect(sheet.locator('.ds-library-action')).toHaveCount(0)
  } else {
    await expect(
      dockNowPlaying.getByRole('link', { name: playing.title }),
    ).toBeFocused()
  }
  const surface = isMobile
    ? sheet.locator('.player-text').first()
    : dockNowPlaying
  await expect(
    surface.getByRole('link', { name: playing.title }),
  ).toHaveAttribute(
    'data-workspace-href',
    `/tracks/catalog-${externalId(playing)}`,
  )
  await expect(
    surface.getByRole('button', { name: savedActionName }),
  ).toHaveCount(0)
  await expect(
    dock
      .locator('.player-row')
      .getByRole('button', { name: 'Play', exact: true }),
  ).toBeEnabled()
  if (isMobile) {
    await expect(
      sheet.getByText('Nothing queued.', { exact: true }),
    ).toBeVisible()
  } else {
    await expect(
      dock.getByRole('button', { name: 'Queue: 0 next' }),
    ).toBeVisible()
  }
  expect(promotions).toEqual([externalId(playing)])
  expect(writes).toEqual([])
})

test('a local recording does not offer a catalog add', async ({
  page,
  isMobile,
}) => {
  const playing = item('track', 21, 'Local recording')
  const release = item('album', 22, 'Saved album')
  const state: SavedPlayback = {
    ...playback(item('track', 23, 'Previous track')),
    snapshot: { ...snapshot(playing, release), isLocal: true },
  }
  await mockPlayback(page, state, new Set([externalId(release)]))
  await page.goto('/tracks')
  const dock = page.locator('.player-dock')
  const nowPlaying = isMobile
    ? page.locator('.player-sheet-body > .player-text')
    : dock.locator('.player-now')
  if (isMobile) {
    await dock
      .getByRole('button', { name: `Open player: ${playing.title}` })
      .click()
  }
  await expect(
    nowPlaying.getByText(playing.title, { exact: true }),
  ).toBeVisible()
  await expect(
    nowPlaying.getByRole('link', { name: release.title, exact: true }),
  ).toHaveAttribute(
    'data-workspace-href',
    `/albums/catalog-${externalId(release)}`,
  )
  await expect(nowPlaying.locator('.ds-library-action')).toHaveCount(0)
  await expect(dock.locator('.player-now .ds-library-action')).toHaveCount(0)
})
