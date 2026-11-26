import { expect, test, type Locator, type Page } from '@playwright/test'
import { z } from 'zod'
import { PlaybackDiagnosticsResultSchema } from '@repo/schemas/playback-diagnostics'
import { TidalSimilarSchema } from '@repo/schemas/tidal'
import { TrackDetailSchema } from '@repo/schemas/tracks'
import { webOrigin } from './preview'

// The preview has several recordings called Hidden Letter; this one has saved recommendations.
const similarSeedPath = '/tracks/track_3c533604ddc8e1666b42'

async function openSimilarSeed(page: Page) {
  await page.goto('/tracks?view=list&q=Hidden+Letter', {
    waitUntil: 'domcontentloaded',
  })
  await page
    .getByRole('link', { name: 'Hidden Letter', exact: true })
    .and(page.locator(`[data-workspace-href="${similarSeedPath}"]`))
    .click()
}

async function headerLayout(header: Locator) {
  return header.evaluate((element) => {
    const origin = element.getBoundingClientRect()
    return ['.ds-art', '.ds-detail-title', '.ds-detail-play button'].map(
      (selector) => {
        const child = element.querySelector(selector)
        if (!child) throw new Error(`Missing track header element ${selector}`)
        const rect = child.getBoundingClientRect()
        const style = getComputedStyle(child)
        return {
          left: Math.round(rect.x - origin.x),
          top: Math.round(rect.y - origin.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          font: style.fontSize,
        }
      },
    )
  })
}

async function openTrackSimilar(page: Page) {
  await openSimilarSeed(page)
  await page.getByRole('tab', { name: 'Similar', exact: true }).click()
}

test('playing a Similar track keeps the recommendations as the playback source', async ({
  page,
  isMobile,
}) => {
  const startedAfter = Date.now()
  const recommendations = [
    { id: '0000000000000000000601', title: 'First recommendation' },
    { id: '0000000000000000000602', title: 'Second recommendation' },
    { id: '0000000000000000000603', title: 'Third recommendation' },
  ]
  const { data } = await (
    await page.request.get(`${webOrigin}/api/v1${similarSeedPath}`)
  ).json()
  const seed = TrackDetailSchema.parse(data)
  if (!seed.spotifyTrackId) throw new Error('Preview track needs a Spotify ID')
  const recordings = [
    ...recommendations,
    { id: seed.spotifyTrackId, title: seed.title },
  ]
  const recommendationUris = recommendations.map(
    ({ id }) => `spotify:track:${id}`,
  )
  const seedUri = `spotify:track:${seed.spotifyTrackId}`
  await page.route(
    `${webOrigin}/api/v1/tidal/similar/tracks/${seed.id}`,
    async (route) => {
      const response = await route.fetch()
      const payload = z
        .object({
          statusCode: z.number(),
          message: z.string(),
          data: TidalSimilarSchema,
        })
        .parse(await response.json())
      await route.fulfill({
        response,
        json: {
          ...payload,
          data: {
            ...payload.data,
            items: recommendations.map(({ id, title }, index) => ({
              tidalId: String(931000 + index),
              title,
              artists: ['Fixture artist'],
              url: `https://tidal.com/browse/track/${931000 + index}`,
              code: null,
              version: null,
              durationSec: 180,
              releaseDate: null,
              state: 'spotify',
              library: null,
              spotify: {
                spotifyId: id,
                title,
                artists: ['Fixture artist'],
                url: `https://open.spotify.com/track/${id}`,
                albumName: null,
                spotifyAlbumId: null,
                artworkUrl: null,
                durationSec: 180,
                trackCount: null,
              },
            })),
          },
        },
      })
    },
  )
  await page.addInitScript(() => {
    let connections = 0
    class FixturePlayer {
      private state: unknown = null
      private activated = false
      private handlers = new AbortController()
      private listeners = new Map<string, (payload: unknown) => void>()
      constructor() {
        const { signal } = this.handlers
        window.addEventListener(
          'fixture-spotify-state',
          (event) => {
            if (event instanceof CustomEvent) {
              if (!this.activated) {
                this.listeners.get('autoplay_failed')?.({})
                return
              }
              this.state = event.detail
              this.listeners.get('player_state_changed')?.(this.state)
            }
          },
          { signal },
        )
        window.addEventListener(
          'fixture-spotify-not-ready',
          () => {
            this.activated = false
            this.listeners.get('not_ready')?.({ device_id: 'fixture-browser' })
          },
          { signal },
        )
        document.documentElement.dataset.fixtureSpotifyLoaded = 'true'
      }
      addListener(event: string, listener: (payload: unknown) => void) {
        this.listeners.set(event, listener)
        return true
      }
      async connect() {
        connections += 1
        document.documentElement.dataset.fixtureSpotifyConnections =
          String(connections)
        this.listeners.get('ready')?.({ device_id: 'fixture-browser' })
        return true
      }
      async getCurrentState() {
        return this.state
      }
      async activateElement() {
        const event = window.event
        this.activated = event?.isTrusted === true && event.type === 'click'
        document.documentElement.dataset.fixtureSpotifyActivation =
          event?.type ?? 'outside-event'
      }
      disconnect() {
        this.handlers.abort()
      }
    }
    window.addEventListener('fixture-load-spotify', () => {
      Object.defineProperty(window, 'Spotify', {
        value: { Player: FixturePlayer },
      })
      window.onSpotifyWebPlaybackSDKReady?.()
    })
  })
  let loadSdk = () => {}
  const sdkLoading = new Promise<void>((resolve) => {
    loadSdk = resolve
  })
  await page.route('https://sdk.scdn.co/spotify-player.js', async (route) => {
    await sdkLoading
    await route.fulfill({
      contentType: 'application/javascript',
      body: "window.dispatchEvent(new Event('fixture-load-spotify'))",
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
  const starts: string[][] = []
  async function reportDeviceTrack(uri: string, next: readonly string[]) {
    const recording = recordings.find(({ id }) => uri === `spotify:track:${id}`)
    if (!recording) throw new Error('Unknown playback fixture')
    await page.evaluate(
      ({ uri, title, next }) =>
        window.dispatchEvent(
          new CustomEvent('fixture-spotify-state', {
            detail: {
              paused: false,
              position: 1_000,
              duration: 180_000,
              track_window: {
                current_track: {
                  uri,
                  name: title,
                  artists: [{ name: 'Fixture artist' }],
                },
                next_tracks: next.map((uri) => ({ uri })),
              },
            },
          }),
        ),
      { uri, title: recording.title, next },
    )
  }
  await page.route('https://api.spotify.com/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/v1/me/player/devices')
      return route.fulfill({ json: { devices: [] } })
    if (url.pathname !== '/v1/me/player/play' || request.method() !== 'PUT')
      return route.fulfill({ status: 204 })
    expect(url.searchParams.get('device_id')).toBe('fixture-browser')
    const { uris } = z
      .object({ uris: z.tuple([z.string()], z.string()) })
      .parse(request.postDataJSON())
    starts.push(uris)
    await route.fulfill({ status: 204 })
    await reportDeviceTrack(uris[0], uris.slice(1))
  })
  const panel = page.getByRole('tabpanel', { name: 'Similar', exact: true })
  const row = panel.getByRole('row', { name: /First recommendation/ })
  try {
    await openTrackSimilar(page)
    if (!isMobile) await row.hover()
    await expect(
      row.getByRole('button', {
        name: 'Play First recommendation: Loading the browser player.',
        exact: true,
      }),
    ).toBeDisabled()
    expect(starts).toEqual([])
  } finally {
    loadSdk()
  }
  await expect(page.locator('html')).toHaveAttribute(
    'data-fixture-spotify-loaded',
    'true',
  )
  if (!isMobile) await row.hover()
  const play = row.getByRole('button', {
    name: 'Play First recommendation',
    exact: true,
  })
  const press = (control: Locator) =>
    isMobile ? control.tap() : control.click()
  await press(play)
  await expect(page.locator('html')).toHaveAttribute(
    'data-fixture-spotify-activation',
    'click',
  )
  const dock = page.locator('.player-dock')
  function nowPlaying(title: string) {
    return isMobile
      ? dock.getByRole('button', { name: `Open player: ${title}` })
      : dock.locator('.player-now').getByText(title, { exact: true })
  }
  const playing = async (title: string) => {
    await expect(nowPlaying(title)).toBeVisible()
    await expect(
      dock
        .locator('.player-row')
        .getByRole('button', { name: 'Pause', exact: true }),
    ).toBeEnabled()
  }
  await playing('First recommendation')
  await expect.poll(() => starts[0]).toEqual(recommendationUris)
  const [, second, third] = recommendationUris
  if (!second || !third) throw new Error('Missing later recommendation')

  await press(page.getByRole('button', { name: 'Close details' }))
  await reportDeviceTrack(second, [third])
  await playing('Second recommendation')

  const seedRow = page.locator('.ds-row').filter({
    has: page.locator(`[data-workspace-href="${similarSeedPath}"]`),
  })
  if (!isMobile) await seedRow.hover()
  await press(
    seedRow.getByRole('button', { name: /Add Hidden Letter to queue/ }),
  )
  await playing('Second recommendation')
  expect(starts).toHaveLength(1)

  await page.evaluate(() =>
    window.dispatchEvent(new Event('fixture-spotify-not-ready')),
  )
  const player = isMobile ? page.locator('.player-sheet') : dock
  if (isMobile) await press(nowPlaying('Second recommendation'))
  await press(player.getByRole('button', { name: 'Next', exact: true }))
  await expect.poll(() => starts[1]).toEqual([seedUri, third])
  await expect(page.locator('html')).toHaveAttribute(
    'data-fixture-spotify-connections',
    '2',
  )
  await playing(seed.title)

  await reportDeviceTrack(third, [])
  await playing('Third recommendation')
  expect(starts).toHaveLength(2)
  if (!isMobile) await press(dock.getByRole('button', { name: /^Queue:/ }))
  await press(player.getByRole('link', { name: /^Back to source:/ }))
  await expect(
    page.getByRole('tab', { name: 'Similar', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  await expect(
    panel.getByRole('row', { name: /Third recommendation/ }),
  ).toBeVisible()

  await page.goBack()
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === '/tracks' &&
      url.searchParams.get('q') === 'Hidden Letter' &&
      !url.searchParams.has('inspect'),
  )
  if (!isMobile) await seedRow.hover()
  await press(
    seedRow.getByRole('button', { name: `Play ${seed.title}`, exact: true }),
  )
  await playing(seed.title)
  if (isMobile) await press(nowPlaying(seed.title))
  else await press(dock.getByRole('button', { name: /^Queue:/ }))
  await expect(
    player.getByRole('link', { name: /^Back to source: Tracks/ }),
  ).toBeVisible()

  await expect(async () => {
    const response = await page.request.get(
      `${webOrigin}/api/v1/playback/diagnostics`,
      { headers: { origin: webOrigin } },
    )
    expect(response.ok()).toBe(true)
    const { data } = await response.json()
    const { events } = PlaybackDiagnosticsResultSchema.parse(data)
    const recent = events.filter(
      ({ browser, receivedAt }) =>
        browser === (isMobile ? 'android' : 'desktop') &&
        receivedAt >= startedAfter,
    )
    const request = recent.find(
      ({ action, spotifyTrackId, stage, target, source, sourceItemId }) =>
        action === 'play' &&
        stage === 'requested' &&
        target === 'local' &&
        source === 'similar-tracks' &&
        sourceItemId === seed.id &&
        spotifyTrackId === recommendations[0]?.id,
    )
    expect(request).toBeDefined()
    expect(
      recent
        .filter(({ attemptId }) => attemptId === request?.attemptId)
        .map(({ stage }) => stage),
    ).toEqual(
      expect.arrayContaining(['activation', 'device', 'command', 'started']),
    )
    expect(recent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'advance',
          source: 'similar-tracks',
          spotifyTrackId: recommendations[1]?.id,
        }),
        expect.objectContaining({
          stage: 'device',
          source: 'similar-tracks',
          reason: 'disconnected',
        }),
        expect.objectContaining({
          stage: 'started',
          source: 'browse',
          spotifyTrackId: seed.spotifyTrackId,
        }),
      ]),
    )
  }).toPass()
})

test('Sources keeps the selected TIDAL edition and links the recommendation evidence', async ({
  page,
}) => {
  await page.route('**/api/v1/tidal/tracks/match/*', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1)
    await route.fulfill({
      json: {
        statusCode: 200,
        message: 'OK',
        data: {
          trackId: id,
          job: null,
          candidates: [],
          match: {
            tidalTrackId: '910001',
            source: 'tidal-track-match',
            matchReason: 'manual',
            alignment: null,
            url: 'https://tidal.com/browse/track/910001',
            version: null,
            durationSec: 191,
            popularity: null,
          },
          similarEditions: [
            {
              tidalTrackId: '910002',
              url: 'https://tidal.com/browse/track/910002',
              sourceItemId: 'example-seed',
              code: 'QZFX12700004',
              jobId: 'example-job',
              responseId: 'example-response',
            },
          ],
        },
      },
    })
  })
  await openSimilarSeed(page)
  await page.getByRole('tab', { name: 'Sources', exact: true }).click()
  await page.locator('summary').filter({ hasText: 'TIDAL' }).click()
  await expect(
    page.getByText(/TIDAL track 910001.*Chosen in review/),
  ).toBeVisible()
  const editions = page.getByLabel('Other TIDAL editions', { exact: true })
  await expect(editions.getByText('TIDAL track 910002')).toBeVisible()
  await expect(editions.getByText(/ISRC QZFX12700004/)).toBeVisible()
  await expect(
    editions.getByRole('link', { name: 'Source job' }),
  ).toHaveAttribute('href', /example-response/)
  await expect(
    editions.getByRole('link', { name: 'Source track' }),
  ).toHaveAttribute('href', /example-seed/)
})

test('track appearances link back to the album and the originating Similar list', async ({
  page,
}) => {
  await openTrackSimilar(page)
  const panel = page.getByRole('tabpanel', { name: 'Similar', exact: true })
  await panel
    .getByRole('link', { name: 'Tidal Basin Edit', exact: true })
    .click()
  const appearances = page.locator('section.ds-section').filter({
    has: page.getByRole('heading', { name: 'Appears in', exact: true }),
  })
  await expect(
    appearances.getByRole('link', { name: 'Harbour Current' }),
  ).toHaveCount(1)
  const seed = appearances.getByRole('link', {
    name: 'Hidden Letter',
    exact: true,
  })
  await expect(seed).toHaveCount(1)
  await seed.click()
  await expect(
    page.getByRole('tab', { name: 'Similar', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  await expect(
    panel.getByRole('link', { name: 'Tidal Basin Edit', exact: true }),
  ).toBeVisible()
})

test('Match on TIDAL shows one status through request, job and result', async ({
  page,
}) => {
  let queued = false
  let complete = false
  let release = () => {}
  const submitting = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/v1/tidal/similar/tracks/*', async (route) => {
    if (route.request().method() === 'POST') {
      await submitting
      queued = true
    }
    await route.fulfill({
      json: {
        statusCode: 200,
        message: 'OK',
        data: TidalSimilarSchema.parse({
          kind: 'track',
          itemId: similarSeedPath.split('/').at(-1),
          matched: false,
          readAt: null,
          items: [],
          source: null,
          job: null,
          lookupJob: null,
          unmatched: complete
            ? { reason: 'not-found', isrc: 'QZFX22800001' }
            : null,
          matchJob: queued
            ? {
                jobId: 'fixture-match',
                status: complete ? 'succeeded' : 'queued',
                createdAt: '2026-01-01T00:00:00Z',
                finishedAt: complete ? '2026-01-01T00:01:00Z' : null,
                errorMessage: null,
              }
            : null,
        }),
      },
    })
  })
  try {
    await openTrackSimilar(page)
    const match = page.getByRole('button', {
      name: 'Match on TIDAL',
      exact: true,
    })
    await match.scrollIntoViewIfNeeded()
    const idle = await match.boundingBox()
    await match.click()
    const pending = page.getByRole('button', { name: 'Matching on TIDAL…' })
    await expect(pending).toBeVisible()
    expect(await pending.boundingBox()).toEqual(idle)
    await expect(page.getByText(/^Matching on TIDAL/)).toHaveCount(1)
  } finally {
    release()
  }
  await expect(
    page.getByRole('button', { name: 'TIDAL match queued' }),
  ).toBeVisible()
  await expect(
    page.getByText('TIDAL match queued', { exact: true }),
  ).toHaveCount(1)
  complete = true
  await expect(page.getByRole('button', { name: 'No match' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Match job' })).toBeVisible()
})

test('a failed Similar request displays the server explanation once', async ({
  page,
}) => {
  const message = 'Fixture provider is unavailable.'
  await page.route('**/api/v1/tidal/similar/tracks/*', async (route) => {
    if (route.request().method() === 'GET') return route.continue()
    await route.fulfill({ status: 503, json: { statusCode: 503, message } })
  })
  await openTrackSimilar(page)
  await page.getByRole('button', { name: 'Read again from TIDAL' }).click()
  await expect(page.getByRole('button', { name: /Read failed/ })).toBeVisible()
  await expect(
    page.getByRole('alert').filter({ hasText: message }),
  ).toBeVisible()
  await expect(page.getByText(message, { exact: true })).toHaveCount(1)
})

test('a first read shows recommendations while the catalog save is pending', async ({
  page,
}) => {
  let reading = false
  let release = () => {}
  const saving = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/v1/tidal/similar/tracks/*', async (route) => {
    if (route.request().method() === 'POST') {
      reading = true
      await saving
    }
    const response = await route.fetch({ method: 'GET' })
    const payload = z
      .object({
        statusCode: z.number(),
        message: z.string(),
        data: TidalSimilarSchema,
      })
      .parse(await response.json())
    const saved = payload.data
    if (route.request().method() === 'POST') {
      await route.fulfill({ response })
      return
    }
    await route.fulfill({
      response,
      json: {
        ...payload,
        data: {
          ...saved,
          readAt: null,
          job: reading
            ? {
                jobId: 'example-read',
                createdAt: new Date().toISOString(),
                finishedAt: null,
                errorMessage: null,
                status: 'running',
              }
            : null,
          items: reading ? saved.items : [],
        },
      },
    })
  })
  try {
    await openTrackSimilar(page)
    await expect(
      page.getByText('Received from TIDAL · updating library matches'),
    ).toBeVisible()
    await expect(
      page.getByRole('row', { name: /Tidal Basin Edit/ }),
    ).toBeVisible()
    await expect(
      page.getByLabel('Add track to library · Tidal Basin Edit'),
    ).toBeDisabled()
  } finally {
    release()
  }
  await expect(
    page.getByLabel('Add track to library · Tidal Basin Edit'),
  ).toBeEnabled()
})

test('Similar tracks open discovered track, artist and album inspectors', async ({
  page,
}) => {
  await openTrackSimilar(page)

  const panel = page.getByRole('tabpanel', { name: 'Similar', exact: true })
  const tableView = panel.getByRole('button', { name: 'Table view' })
  await expect(tableView).toHaveAttribute('aria-pressed', 'true')
  const tableRow = panel.getByRole('row', { name: /Tidal Basin Edit/ })
  const tableTitle = tableRow.getByRole('link', {
    name: 'Tidal Basin Edit',
    exact: true,
  })
  await expect(tableTitle).toBeVisible()
  const trackHref = await tableTitle.getAttribute('href')
  if (!trackHref) throw new Error('Missing recommended track link')
  await expect(tableRow.getByText('4:23')).toBeVisible()
  await tableTitle.focus()
  await expect(
    tableRow.getByRole('button', { name: /^Play Tidal Basin Edit/ }),
  ).toBeDisabled()
  await expect(
    tableRow.getByRole('button', { name: /^Add Tidal Basin Edit to queue/ }),
  ).toBeDisabled()
  await expect(
    tableRow.getByLabel('Add track to library · Tidal Basin Edit'),
  ).toBeVisible()

  const gridView = panel.getByRole('button', { name: 'Grid view' })
  await gridView.click()
  await expect(gridView).toHaveAttribute('aria-pressed', 'true')
  await expect(tableRow).toHaveCount(0)
  const gridTitle = panel.getByRole('link', {
    name: 'Tidal Basin Edit',
    exact: true,
  })
  await expect(gridTitle).toHaveAttribute('href', trackHref)
  await gridTitle.focus()
  await expect(
    panel.getByRole('button', { name: /^Play Tidal Basin Edit/ }),
  ).toBeVisible()
  await gridTitle.click()
  await expect(
    page.getByRole('heading', { name: 'Tidal Basin Edit' }),
  ).toBeVisible()
  await page.goBack()
  await expect(gridView).toHaveAttribute('aria-pressed', 'true')

  const detailView = panel.getByRole('button', { name: 'Detail view' })
  await detailView.click()
  await expect(detailView).toHaveAttribute('aria-pressed', 'true')

  const row = panel
    .getByLabel('Similar tracks', { exact: true })
    .locator('section')
    .filter({ hasText: 'Tidal Basin Edit' })
  const title = row.getByRole('link', { name: 'Tidal Basin Edit', exact: true })
  await expect(title).toBeVisible()
  const suggested = await headerLayout(row.locator('header'))
  await expect(
    row.getByRole('heading', { name: 'Tidal Basin Edit' }),
  ).toBeVisible()
  await expect(row.getByText('4:23')).toBeVisible()
  await expect(row.getByRole('link', { name: /Open on Last.fm/ })).toBeVisible()
  await title.focus()
  await expect(
    row.getByRole('button', { name: /Play Tidal Basin Edit/ }),
  ).toBeDisabled()
  await expect(
    row.getByRole('button', { name: /Add Tidal Basin Edit to queue/ }),
  ).toBeDisabled()
  await expect(
    row.getByLabel('Add track to library · Tidal Basin Edit'),
  ).toBeVisible()
  await expect(row.getByText('Unavailable')).toBeVisible()

  await row.getByRole('link', { name: 'Halden Row', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Halden Row' })).toBeVisible()
  await page.goBack()

  await row.getByRole('link', { name: 'Harbour Current', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Harbour Current' }),
  ).toBeVisible()
  await page.goBack()

  await row
    .getByRole('link', { name: 'Open details for Tidal Basin Edit' })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Tidal Basin Edit' }),
  ).toBeVisible()
  expect(
    await headerLayout(page.locator('.dtl-detail > header').last()),
  ).toEqual(suggested)
})

test('a discovered artist opened from Similar shows the native Spotify ID in Sources', async ({
  page,
}) => {
  await openTrackSimilar(page)
  const row = page
    .getByRole('tabpanel', { name: 'Similar', exact: true })
    .getByRole('row', { name: /Northbound Echo/ })
  await row.getByRole('link', { name: 'Glass Meridian', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Glass Meridian', exact: true }),
  ).toBeVisible()
  await page.getByRole('tab', { name: 'Sources', exact: true }).click()
  const sources = page.getByRole('tabpanel', { name: 'Sources', exact: true })
  const spotify = sources.locator('summary').filter({
    has: page.getByText('Spotify', { exact: true }),
  })
  await expect(
    spotify.getByText('pvKQhaowdxw4wYTFqEA9V7', { exact: true }),
  ).toBeVisible()
})

test('Similar albums and tracks remember their views independently', async ({
  page,
}) => {
  const panel = page.getByRole('tabpanel', { name: 'Similar', exact: true })
  const detail = panel.getByRole('button', { name: 'Detail view' })
  const grid = panel.getByRole('button', { name: 'Grid view' })
  const table = panel.getByRole('button', { name: 'Table view' })
  const similar = page.getByRole('tab', { name: 'Similar', exact: true })
  const albumTitle = panel.getByText('Evening Transmissions', { exact: true })

  await openTrackSimilar(page)
  await grid.click()
  await expect(grid).toHaveAttribute('aria-pressed', 'true')

  await page.goto('/albums/pv-album-01')
  await similar.click()
  await expect(detail).toHaveAttribute('aria-pressed', 'true')
  await expect(albumTitle).toBeVisible()
  await grid.click()
  await expect(grid).toHaveAttribute('aria-pressed', 'true')
  await expect(albumTitle).toBeVisible()
  await table.click()
  await expect(table).toHaveAttribute('aria-pressed', 'true')
  await expect(
    panel.getByRole('row', { name: /Evening Transmissions/ }),
  ).toBeVisible()

  await page.reload()
  await similar.click()
  await expect(table).toHaveAttribute('aria-pressed', 'true')

  await openTrackSimilar(page)
  await expect(grid).toHaveAttribute('aria-pressed', 'true')
  await expect(
    panel.getByRole('link', { name: 'Tidal Basin Edit', exact: true }),
  ).toBeVisible()
})
