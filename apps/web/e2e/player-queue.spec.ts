import { expect, test, type Locator, type Page } from '@playwright/test'
import type { PlayableItem, SavedPlayback } from '@repo/schemas/playback'
import {
  PlaybackCatalogInputSchema,
  PlaybackSyncInputSchema,
} from '@repo/schemas/playback'
import { CatalogMembershipInputSchema } from '@repo/schemas/manual-add'
import { AlbumDetailSchema } from '@repo/schemas/media'
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

for (const from of ['Tracks Browse', 'album tracks']) {
  test(`playing from ${from} keeps the saved track through a verified device substitution`, async ({
    page,
    isMobile,
  }) => {
    const response = await page.request.get(
      `${webOrigin}/api/v1/albums/pv-album-01`,
    )
    const { data } = await response.json()
    const album = AlbumDetailSchema.parse(data)
    const track = album.tracks.find(({ track }) => track.spotifyTrackId)?.track
    if (!track?.spotifyTrackId) throw new Error('Missing playable fixture')
    if (!track.inLibrary) {
      const saved = await page.request.post(
        `${webOrigin}/api/v1/catalog/media/${track.id}/add`,
        {
          headers: { origin: webOrigin },
        },
      )
      expect(saved.ok()).toBe(true)
    }
    const originalUri = `spotify:track:${track.spotifyTrackId}`
    const alternateUri = item(
      'track',
      from === 'album tracks' ? 351 : 352,
      'Substitute',
    ).uri
    const isrc = 'ZZAAA2400001'
    const deviceTrack = {
      uri: alternateUri,
      name: track.title,
      duration_ms: 180_000,
      external_ids: { isrc },
      album: {
        uri: item('album', 353, 'Release').uri,
        name: album.title,
      },
      artists: track.artists.map((name) => ({ name })),
    }
    await page.addInitScript(() => {
      let state: unknown = null
      window.addEventListener('fixture-spotify-state', (event) => {
        if (event instanceof CustomEvent) state = event.detail
      })
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
          return state
        }
        async activateElement() {}
        disconnect() {}
      }
      Object.defineProperty(window, 'Spotify', {
        value: { Player: FixturePlayer },
      })
    })
    await page.route(`${webOrigin}/api/v1/spotify/status`, (route) =>
      route.fulfill({
        json: {
          statusCode: 200,
          message: 'OK',
          data: {
            configured: true,
            connected: true,
            expiresAt: null,
            scope: null,
            redirectUri: null,
            playback: true,
            playbackHistory: false,
            playlists: false,
            playlistChanges: false,
          },
        },
      }),
    )
    await page.route(`${webOrigin}/api/v1/spotify/playback/token`, (route) =>
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
    let verified = false
    await page.route('https://api.spotify.com/v1/**', async (route) => {
      const request = route.request()
      const { pathname } = new URL(request.url())
      if (pathname === '/v1/me/player/play' && request.method() === 'PUT') {
        expect(request.postDataJSON().uris[0]).toBe(originalUri)
        // The device must expose the new track when the play response is acknowledged.
        await page.evaluate(
          (track) =>
            window.dispatchEvent(
              new CustomEvent('fixture-spotify-state', {
                detail: {
                  paused: false,
                  position: 1_000,
                  duration: 180_000,
                  track_window: { current_track: track, next_tracks: [] },
                },
              }),
            ),
          deviceTrack,
        )
        await route.fulfill({ status: 204 })
      } else if (pathname === `/v1/tracks/${track.spotifyTrackId}`) {
        verified = true
        await route.fulfill({ json: deviceTrack })
      } else if (pathname === '/v1/me/player/devices') {
        await route.fulfill({ json: { devices: [] } })
      } else {
        await route.fulfill({ status: 204 })
      }
    })
    const albumHref = `/albums/${album.id}?tab=tracks`
    const browseHref = `/tracks?${new URLSearchParams({ view: 'list', q: track.title })}`
    await page.goto(from === 'album tracks' ? albumHref : browseHref)
    const trackPath = `/tracks/${track.id}`
    const sourceLink = page.locator(
      `[data-workspace-href="${trackPath}"], a[href="${trackPath}"]`,
    )
    const sourceRow =
      from === 'album tracks' ? page.getByRole('row') : page.locator('.ds-row')
    const row = sourceRow.filter({ has: sourceLink })
    if (!isMobile) await row.hover()
    const play = row.getByRole('button', {
      name: `Play ${track.title}`,
      exact: true,
    })
    await expect(play).toBeEnabled()
    const observed = page.waitForResponse((response) => {
      if (!response.url().endsWith('/api/v1/playback/catalog')) return false
      const body = PlaybackCatalogInputSchema.parse(
        response.request().postDataJSON(),
      )
      return body.items.some(
        ({ spotifyId }) => `spotify:track:${spotifyId}` === alternateUri,
      )
    })
    await play.click()
    const catalog = await observed
    expect(catalog.ok()).toBe(true)
    expect(
      PlaybackCatalogInputSchema.parse(catalog.request().postDataJSON())
        .items[0]?.isrc,
    ).toBe(isrc)
    expect(verified).toBe(true)
    if (isMobile)
      await page
        .getByRole('button', { name: `Open player: ${track.title}` })
        .click()
    const now = page.locator(
      isMobile ? '.player-sheet-body > .player-text' : '.player-now',
    )
    const link = now.getByRole('link', { name: track.title, exact: true })
    await expect(link).toHaveAttribute(
      'data-workspace-href',
      `/tracks/${track.id}`,
    )
    await expect(
      now.getByRole('button', { name: /^Add track to library/ }),
    ).toHaveCount(0)
    // The Next development badge can sit directly over the bottom-left dock link.
    const badge = page.getByRole('button', { name: 'Collapse issues badge' })
    if (await badge.isVisible()) await badge.click()
    await link.click()
    await expect(
      page
        .locator('.dtl-detail > header')
        .last()
        .getByRole('heading', { name: track.title }),
    ).toBeVisible()
  })
}

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
          controls.every((control) => {
            const bounds = title.getBoundingClientRect()
            return (
              bounds.right <= control.left ||
              bounds.left >= control.right ||
              bounds.bottom <= control.top ||
              bounds.top >= control.bottom
            )
          }),
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
  const title = queuedRow.locator('.queue-item strong')
  const titleBefore = await actionPosition(title)
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
  await expect(queuedRow.locator('.ds-library-action')).toHaveText('Added', {
    useInnerText: true,
  })
  expect(await actionPosition(title)).toEqual(titleBefore)
  await expect(
    page.getByText(`Added album to library · ${queued.title}`, { exact: true }),
  ).toHaveCount(0)
  await expect(queuedRow.locator('.ds-library-action')).toHaveCount(0)
  const savedLink = queuedRow.getByRole('link', { name: queued.title })
  await expect(savedLink).toHaveAttribute(
    'data-workspace-href',
    `/albums/catalog-${externalId(queued)}`,
  )
  if (!isMobile) await expect(savedLink).toBeFocused()
  expect(await actionPosition(play)).toEqual(before)
  expect(await actionPosition(title)).toEqual(titleBefore)
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

test('queue feedback follows the action when a row stays or disappears', async ({
  page,
  isMobile,
}) => {
  const first = item('track', 31, 'First queued track')
  const second = item('track', 32, 'Second queued track')
  const saved: SavedPlayback = {
    ...playback(first),
    current: null,
    currentFromSource: false,
    queue: [
      { key: 'queue-1', item: first },
      { key: 'queue-2', item: second },
    ],
  }
  await mockPlayback(
    page,
    saved,
    new Set([externalId(first), externalId(second)]),
  )
  let grantDriver = false
  let releasePlay = () => {}
  const heldPlay = new Promise<void>((resolve) => {
    releasePlay = resolve
  })
  let releaseRemoval = () => {}
  const heldRemoval = new Promise<void>((resolve) => {
    releaseRemoval = resolve
  })
  await page.route(`${webOrigin}/api/v1/playback/session`, async (route) => {
    const input = PlaybackSyncInputSchema.parse(route.request().postDataJSON())
    if (input.claim && !grantDriver) await heldPlay
    if (input.state?.queue.length === 1) {
      await heldRemoval
      await route.fulfill({
        status: 503,
        json: { message: 'Fixture sync failed' },
      })
      return
    }
    await route.fulfill({
      json: {
        statusCode: 200,
        message: 'OK',
        data: {
          revision: 1,
          role: grantDriver ? 'driver' : 'follower',
          driver: { clientId: 'fixture-driver', name: 'Fixture browser' },
          changed: input.revision === 0,
          state: input.revision === 0 ? saved : null,
        },
      },
    })
  })
  await page.goto('/tracks')
  const surface = isMobile
    ? page.locator('.player-sheet-body')
    : page.getByRole('region', { name: 'Queue', exact: true })
  await page
    .getByRole('button', {
      name: isMobile ? /^Open player:/ : /^Queue: 2 next$/,
    })
    .click()
  const queue = surface.locator('.queue-contents')
  const heading = queue.getByRole('heading', { name: 'Queued', exact: true })
  const fallback = queue.locator('.queue-heading [role=status]')
  const firstRow = queue.locator('.queue-row').filter({ hasText: first.title })
  const secondRow = queue
    .locator('.queue-row')
    .filter({ hasText: second.title })
  const play = firstRow.locator('.queue-actions button').first()
  const neighbor = secondRow.locator('.queue-actions button').first()
  await expect(play).toHaveAccessibleName(`Play ${first.title} now`)
  const before = await actionPosition(play)
  const secondBefore = await actionPosition(neighbor)
  const headingHeight = (await heading.boundingBox())?.height
  expect(headingHeight).toBeGreaterThan(0)
  try {
    await play.click()
    await expect(play).toHaveAttribute('data-feedback', 'pending')
    await expect(play).toHaveAccessibleName(/Starting…/)
    await expect(fallback).toBeEmpty()
    expect(await actionPosition(play)).toEqual(before)
    expect(await actionPosition(neighbor)).toEqual(secondBefore)
  } finally {
    releasePlay()
  }
  await expect(play).toHaveAttribute('data-feedback', 'unconfirmed')
  await expect(play).toHaveAccessibleName(/Playback unconfirmed/)
  await expect(fallback).toBeEmpty()
  expect(await actionPosition(play)).toEqual(before)

  grantDriver = true
  try {
    await firstRow.getByRole('button', { name: /^Remove / }).click()
    await expect(firstRow).toHaveCount(0)
    await expect(fallback).toHaveText(/Removed .* · syncing…/)
    expect(await actionPosition(neighbor)).toEqual(secondBefore)
    expect((await heading.boundingBox())?.height).toBe(headingHeight)
  } finally {
    releaseRemoval()
  }
  await expect(fallback).toHaveText(/Removed .* · sync unconfirmed/)
  expect(await actionPosition(neighbor)).toEqual(secondBefore)
  expect((await heading.boundingBox())?.height).toBe(headingHeight)
})

test('transport commands and slider receipts keep the player layout stable', async ({
  page,
  isMobile,
}) => {
  const playing = item('track', 1, 'Playing track')
  const nextTrack = item('track', 2, 'Next track')
  const album = item('album', 3, 'Album')
  const device = {
    id: 'fixture-speaker',
    name: 'Fixture speaker',
    type: 'Speaker',
    volume: 0.5,
  }
  let saved: SavedPlayback | null = {
    ...playback(playing),
    currentFromSource: false,
    snapshot: snapshot(playing, album),
    target: { kind: 'spotify', device, browser: null },
    session: {
      item: playing,
      sent: [playing],
      index: 0,
      anchorUri: playing.uri,
    },
  }
  await mockPlayback(
    page,
    saved,
    new Set([externalId(playing), externalId(nextTrack), externalId(album)]),
  )
  let revision = 1
  let holdShuffle: Promise<void> | undefined
  await page.route(`${webOrigin}/api/v1/playback/session`, async (route) => {
    const input = PlaybackSyncInputSchema.parse(route.request().postDataJSON())
    const changed = input.revision !== revision
    if (!changed && input.state !== undefined) {
      if (input.state?.shuffle) await holdShuffle
      saved = input.state
      revision += 1
    }
    await route.fulfill({
      json: {
        statusCode: 200,
        message: 'OK',
        data: {
          revision,
          role: 'driver',
          driver: { clientId: input.clientId, name: input.clientName },
          changed,
          state: changed ? saved : null,
        },
      },
    })
  })
  let position = 50_000
  let volume = 50
  let paused = true
  let current = playing
  let hold: {
    command: string
    requested: () => void
    response: Promise<void>
  } | null = null
  await page.route('https://api.spotify.com/v1/**', async (route) => {
    const { pathname, searchParams } = new URL(route.request().url())
    if (route.request().method() === 'GET') {
      if (pathname.endsWith('/devices')) {
        await route.fulfill({ json: { devices: [] } })
        return
      }
      if (pathname === '/v1/me/player') {
        await route.fulfill({
          json: {
            device: {
              id: device.id,
              name: device.name,
              type: device.type,
              is_active: true,
              volume_percent: volume,
            },
            context: { uri: album.uri },
            progress_ms: position,
            is_playing: !paused,
            item: {
              uri: current.uri,
              name: current.title,
              duration_ms: 200_000,
              artists: [{ name: playing.artist }],
              album: { uri: album.uri, name: album.title },
            },
          },
        })
        return
      }
      await route.fulfill({ status: 204 })
      return
    }
    const command = pathname.split('/').at(-1)
    if (hold && command === hold.command) {
      hold.requested()
      await hold.response
    }
    if (command === 'seek') position = Number(searchParams.get('position_ms'))
    if (command === 'volume')
      volume = Number(searchParams.get('volume_percent'))
    if (command === 'play') paused = false
    if (command === 'next') {
      current = nextTrack
      position = 0
    }
    await route.fulfill({ status: 204 })
  })
  await page.goto('/tracks')
  if (isMobile)
    await page.getByRole('button', { name: /^Open player:/ }).click()
  const player = page.locator(isMobile ? '.player-sheet-body' : '.player-dock')
  const seek = player.getByRole('slider', { name: 'Seek' })
  const volumeSlider = player.getByRole('slider', { name: 'Volume' })
  const shuffle = player.locator('.player-buttons button').nth(0)
  const previous = player.locator('.player-buttons button').nth(1)
  const play = player.locator('.player-buttons button').nth(2)
  const next = player.locator('.player-buttons button').nth(3)
  const mute = player.locator('.player-volume button')
  await expect(play).toHaveAccessibleName('Play')
  await expect(seek).toHaveValue('50000')
  await expect(volumeSlider).toHaveValue('0.5')
  await page.evaluate(async () => {
    await document.fonts.ready
  })

  const geometry = () =>
    player.evaluate((surface) => {
      const origin = surface.getBoundingClientRect()
      const neighbors = surface.querySelectorAll(
        '.player-text, .player-buttons, .player-buttons button, .player-scrub, .player-time, .player-range input, .player-tools, .player-sheet-actions, .player-volume, .player-volume button',
      )
      return [...neighbors, surface].map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect()
        return [x - origin.x, y - origin.y, width, height].map((value) =>
          Math.round(value * 10),
        )
      })
    })
  const initial = await geometry()
  async function checkWhileHeld(
    command: string,
    start: () => Promise<void>,
    pending: () => Promise<void>,
  ) {
    let requestArrived = () => {}
    let release = () => {}
    const requested = new Promise<void>((resolve) => {
      requestArrived = resolve
    })
    hold = {
      command,
      requested: requestArrived,
      response: new Promise<void>((resolve) => {
        release = resolve
      }),
    }
    try {
      await start()
      await requested
      await pending()
      expect(await geometry()).toEqual(initial)
    } finally {
      release()
      hold = null
    }
  }

  await checkWhileHeld(
    'seek',
    () => seek.press('ArrowRight'),
    async () => {
      await expect(seek).toHaveValue('51000')
      await expect(player.locator('.player-scrub [role=status]')).toHaveText(
        'Seeking…',
      )
    },
  )
  await expect(player.locator('.player-scrub [role=status]')).toHaveText(
    'At 0:51',
  )
  await expect(player.locator('.player-scrub [role=status]')).toHaveClass(
    'sr-only',
  )
  await expect.poll(geometry).toEqual(initial)

  await checkWhileHeld(
    'volume',
    () => volumeSlider.press('ArrowRight'),
    async () => {
      await expect(volumeSlider).toHaveValue('0.51')
      await expect(player.locator('.player-volume [role=status]')).toHaveText(
        'Setting volume…',
      )
    },
  )
  await expect(player.locator('.player-volume [role=status]')).toHaveText(
    'Volume 51%',
  )
  await expect(player.locator('.player-volume [role=status]')).toHaveClass(
    'sr-only',
  )
  await expect.poll(geometry).toEqual(initial)

  let releaseShuffle = () => {}
  holdShuffle = new Promise<void>((resolve) => {
    releaseShuffle = resolve
  })
  try {
    await shuffle.click()
    await expect(shuffle).toHaveAttribute('data-feedback', 'running')
    expect(await geometry()).toEqual(initial)
  } finally {
    releaseShuffle()
  }
  await expect(shuffle).toHaveAttribute('data-feedback', 'done')
  await expect.poll(geometry).toEqual(initial)

  for (const [command, control, completion] of [
    ['volume', mute, /Muted/],
    ['seek', previous, /Track restarted/],
    ['play', play, /Playing/],
    ['next', next, /Skipped/],
  ] as const) {
    await checkWhileHeld(
      command,
      () => control.click(),
      async () => {
        await expect(control).toHaveAttribute('data-feedback', 'pending')
        await expect(control).toHaveAttribute('data-icon', '')
      },
    )
    await expect(control).toHaveAccessibleName(completion)
    await expect.poll(geometry).toEqual(initial)
  }
})

test('a device discovery retry stays visible and reports the result it read', async ({
  page,
  isMobile,
}) => {
  const playing = item('track', 1, 'Playing track')
  await mockPlayback(page, playback(playing), new Set([externalId(playing)]))
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let reads = 0
  await page.route(
    'https://api.spotify.com/v1/me/player/devices',
    async (route) => {
      reads += 1
      if (reads === 1) {
        await route.fulfill({
          status: 503,
          json: { error: { status: 503, message: 'Synthetic device failure' } },
        })
        return
      }
      await held
      await route.fulfill({ json: { devices: [] } })
    },
  )
  await page.goto('/tracks')
  if (isMobile)
    await page.getByRole('button', { name: /^Open player:/ }).click()
  const surface = isMobile
    ? page.locator('.player-sheet-body')
    : page.locator('.player-dock')
  await surface.getByRole('button', { name: /Play on:/ }).click()
  const devices = surface.locator('.device-list')
  await expect(
    surface.getByRole('button', {
      name: /Device list failed · retry · Play on:/,
    }),
  ).toBeVisible()
  const retry = devices.getByRole('button', { name: /Retry device list$/ })
  const picker = surface.getByRole('button', { name: /Play on:/ })
  const retryBefore = await retry.boundingBox()
  const pickerBefore = await picker.boundingBox()
  expect(retryBefore).not.toBeNull()
  expect(pickerBefore).not.toBeNull()
  try {
    await retry.click()
    await expect(retry).toHaveText('Finding devices…', { useInnerText: true })
    await expect(retry).toBeDisabled()
    expect(await retry.boundingBox()).toEqual(retryBefore)
    expect(await picker.boundingBox()).toEqual(pickerBefore)
    await expect(
      surface.getByText('Finding devices…', { exact: true }),
    ).toHaveCount(1)
  } finally {
    release()
  }
  await expect(retry).toHaveText('No other Spotify devices', {
    useInnerText: true,
  })
  expect(await retry.boundingBox()).toEqual(retryBefore)
  expect(await picker.boundingBox()).toEqual(pickerBefore)
  await expect(
    surface.getByText('No other Spotify devices', { exact: true }),
  ).toHaveCount(1)
  expect(reads).toBe(2)
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
  await expect(dockNowPlaying.locator('.ds-library-action')).toHaveText(
    'Added',
    {
      useInnerText: true,
    },
  )
  await expect(
    page.getByText(`Added track to library · ${playing.title}`, {
      exact: true,
    }),
  ).toHaveCount(0)
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
