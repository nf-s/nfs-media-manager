import { expect, test, type Page } from '@playwright/test'
import { BrowsePageSliceSchema } from '@repo/schemas/browse'
import { CatalogObservationPageSchema } from '@repo/schemas/catalog'
import {
  SourceSnapshotPageSchema,
  SourceSnapshotSchema,
} from '@repo/schemas/media'
import {
  PlaybackCatalogInputSchema,
  PlaybackCatalogResultSchema,
} from '@repo/schemas/playback'
import { DIRECT_PROVIDER_RESPONSE_SOURCE } from '@repo/schemas/provider-response'
import {
  SpotifyInteractiveTrackSearchResultSchema,
  SpotifyTrackSearchAcceptInputSchema,
  SpotifyTrackSearchSchema,
} from '@repo/schemas/spotify-track-search'
import { TrackListItemSchema } from '@repo/schemas/tracks'
import { webOrigin } from './preview'

const trackTitle = 'Faraway Light'
const localAlbumTitle = 'Untitled Demos 2003'
const localAlbumId = 'pv-album-53'
const unmatchedTrackId = 'library-track_e385979c595d2871dc98'
const matchedTrackId = 'track_83307f487a95e9ada8c9'
const spotifyTrackId = 'pvuFtXDkXDbZZYG0fD2Pej'
const spotifyAlbumId = 'pvaqIgCdRFIj8juMp9BDZ8'
const albumTitle = 'Coastal Interference'
const searchPath = `${webOrigin}/api/v1/spotify/tracks/search`
const resolvePath = `${webOrigin}/api/v1/catalog/spotify-album-reference`
const browsePage = BrowsePageSliceSchema(TrackListItemSchema)

async function recordOutsideAlbum(page: Page) {
  const response = await page.request.post(
    `${webOrigin}/api/v1/playback/catalog`,
    {
      headers: { origin: webOrigin },
      data: PlaybackCatalogInputSchema.parse({
        operation: 'playback',
        items: [
          {
            kind: 'album',
            spotifyId: spotifyAlbumId,
            title: albumTitle,
            artists: [{ name: 'Lowland Static' }],
          },
        ],
      }),
    },
  )
  expect(response.status()).toBe(200)
  const { data } = await response.json()
  const [album] = PlaybackCatalogResultSchema.parse(data).items
  if (!album) throw new Error('The preview did not record the outside album')
  expect(album.item.inLibrary).toBe(false)
  return album.item.id
}

async function blockTextSearch(page: Page) {
  const requests: string[] = []
  for (const path of [searchPath, `${webOrigin}/api/v1/manual-add/search`]) {
    await page.route(path, async (route) => {
      requests.push(route.request().url())
      await route.abort()
    })
  }
  return requests
}

function albumDetails(page: Page) {
  return page.getByRole('complementary', { name: 'Album details' })
}

async function expectAlbumOpen(page: Page, id: string, title: string) {
  await expect(page).toHaveURL((url) =>
    Boolean(url.searchParams.get('inspect')?.includes(id)),
  )
  await expect(
    albumDetails(page).getByRole('heading', { name: title, exact: true }),
  ).toBeVisible()
}

async function mockDirectResponseEvidence(page: Page, albumId: string) {
  const observedAt = '2026-01-03T00:00:00.000Z'
  const evidence = [
    {
      mediaItemId: albumId,
      mediaType: 'album',
      operation: 'provider-result',
      body: { id: spotifyAlbumId, name: albumTitle },
    },
    {
      mediaItemId: matchedTrackId,
      mediaType: 'track',
      operation: 'parent-reference',
      body: {
        id: spotifyTrackId,
        album: { id: spotifyAlbumId, name: albumTitle },
      },
    },
  ]
  const pagination = { page: 1, size: 10, pageCount: 1 }
  const items = evidence.map(({ mediaItemId, mediaType, operation }) => ({
    id: `fixture-${operation}`,
    provider: 'spotify',
    operation,
    subjectKind: mediaType,
    subjectId: mediaItemId,
    relationshipRole: mediaType === 'track' ? 'album' : null,
    page: null,
    position: null,
    jobId: null,
    responseId: null,
    details: [],
    snapshotId: `fixture-${mediaType}-snapshot`,
    directResponse: { mediaItemId, mediaType },
    importId: null,
    observedAt,
  }))
  await page.route(
    `${webOrigin}/api/v1/catalog/media/${albumId}/discoveries?*`,
    (route) =>
      route.fulfill({
        json: {
          statusCode: 200,
          message: 'OK',
          data: CatalogObservationPageSchema.parse({
            ...pagination,
            totalCount: items.length,
            items,
          }),
        },
      }),
  )
  for (const { mediaItemId, mediaType, body } of evidence) {
    const sourcePath = `${webOrigin}/api/v1/media/${mediaItemId}/sources/spotify`
    const snapshot = {
      id: `fixture-${mediaType}-snapshot`,
      provider: 'spotify',
      source: DIRECT_PROVIDER_RESPONSE_SOURCE,
      jobId: null,
      createdAt: observedAt,
    }
    await page.route(`${sourcePath}/history?*`, (route) =>
      route.fulfill({
        json: {
          statusCode: 200,
          message: 'OK',
          data: SourceSnapshotPageSchema.parse({
            ...pagination,
            totalCount: 1,
            items: [snapshot],
          }),
        },
      }),
    )
    await page.route(`${sourcePath}/snapshots/${snapshot.id}`, (route) =>
      route.fulfill({
        json: {
          statusCode: 200,
          message: 'OK',
          data: SourceSnapshotSchema.parse({
            ...snapshot,
            normalizedData: null,
            data: {
              request: {
                method: 'GET',
                url: `https://api.spotify.com/v1/${mediaType}s/${body.id}`,
              },
              response: {
                status: 200,
                body: { state: 'captured', text: JSON.stringify(body) },
              },
            },
          }),
        },
      }),
    )
  }
}

test('an interactive Spotify search shows candidates in the same request and confirms the selected recording', async ({
  page,
  isMobile,
}) => {
  const queued = await blockTextSearch(page)
  const searchId = 'fixture-interactive-search'
  const direct = SpotifyInteractiveTrackSearchResultSchema.parse({
    searchId,
    query: 'Faraway Light',
    searchedAt: '2026-01-03T00:00:00.000Z',
    candidates: [
      {
        spotifyTrackId,
        title: trackTitle,
        artists: ['Rook Abernathy'],
        albumName: albumTitle,
        spotifyAlbumId,
        durationSec: 180,
        artworkUrl: null,
        isrc: null,
        spotifyUrl: `https://open.spotify.com/track/${spotifyTrackId}`,
      },
    ],
  })
  const path = `${searchPath}/${unmatchedTrackId}`
  let searches = 0
  await page.route(path, async (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toMatchObject({
        query: direct.query,
      })
      searches++
      await route.fulfill({
        json: { statusCode: 200, message: 'OK', data: direct },
      })
    } else {
      await route.fulfill({
        json: {
          statusCode: 200,
          message: 'OK',
          data: SpotifyTrackSearchSchema.parse({
            job: null,
            query: '',
            candidates: [],
          }),
        },
      })
    }
  })
  let accepted = false
  await page.route(`${path}/accept`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({ searchId, spotifyTrackId })
    accepted = true
    await route.fulfill({
      json: {
        statusCode: 200,
        message: 'OK',
        data: { targetId: matchedTrackId },
      },
    })
  })
  await page.goto(
    `/tracks?view=${isMobile ? 'list' : 'table'}&q=Faraway%20Light`,
  )
  await page
    .getByRole('button', { name: `Match ${trackTitle} to Spotify` })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Spotify track search' })
  await dialog
    .getByRole('searchbox', { name: 'Search Spotify' })
    .fill(direct.query)
  await dialog.getByRole('button', { name: 'Search', exact: true }).click()
  await dialog
    .getByRole('button', { name: `Review ${trackTitle} from ${albumTitle}` })
    .click()
  expect(accepted).toBe(false)
  await dialog.getByRole('button', { name: 'Confirm Spotify match' }).click()
  await expect(dialog).toBeHidden()
  expect(accepted).toBe(true)
  expect(searches).toBe(1)
  expect(queued).toEqual([])
})

test('a saved track offers manual Spotify matching in its title and opens the exact release after matching', async ({
  page,
  isMobile,
}) => {
  const outsideAlbumId = await recordOutsideAlbum(page)
  const searches = await blockTextSearch(page)
  const lookups: unknown[] = []
  await page.context().route(resolvePath, async (route) => {
    expect(route.request().method()).toBe('POST')
    lookups.push(route.request().postDataJSON())
    // Playback saved a catalog stub. Use a synthetic resolution result so the
    // preview never needs Spotify to open the same album in a panel or tab.
    await route.fulfill({
      json: {
        statusCode: 200,
        message: 'OK',
        data: { mediaItemId: outsideAlbumId },
      },
    })
  })
  const jobId = 'fixture-saved-spotify-search'
  const match = SpotifyTrackSearchSchema.parse({
    job: {
      jobId,
      status: 'succeeded',
      resultCount: 1,
      errorMessage: null,
      createdAt: '2026-01-03T00:00:00.000Z',
      startedAt: '2026-01-03T00:00:00.000Z',
      finishedAt: '2026-01-03T00:00:01.000Z',
    },
    query: trackTitle,
    candidates: [
      {
        spotifyTrackId,
        title: trackTitle,
        artists: ['Rook Abernathy'],
        albumName: albumTitle,
        spotifyAlbumId,
        durationSec: 180,
        artworkUrl: null,
        isrc: null,
        spotifyUrl: `https://open.spotify.com/track/${spotifyTrackId}`,
      },
    ],
  })
  let accepted = false
  await page.route(`${searchPath}/${unmatchedTrackId}`, async (route) => {
    await route.fulfill({
      json: { statusCode: 200, message: 'OK', data: match },
    })
  })
  await page.route(
    `${searchPath}/${unmatchedTrackId}/accept`,
    async (route) => {
      expect(route.request().method()).toBe('POST')
      expect(
        SpotifyTrackSearchAcceptInputSchema.parse(
          route.request().postDataJSON(),
        ),
      ).toEqual({ jobId, spotifyTrackId })
      accepted = true
      await route.fulfill({
        json: {
          statusCode: 200,
          message: 'OK',
          data: { targetId: matchedTrackId },
        },
      })
    },
  )
  await page.route(
    `${webOrigin}/api/v1/tracks/browse-page?*`,
    async (route) => {
      if (!accepted) return route.continue()
      const response = await route.fetch()
      const envelope = await response.json()
      const data = browsePage.parse(envelope.data)
      // The preview has no search worker. Emulate the Browse result after the
      // saved match selects an existing Spotify recording in the same database.
      const items = data.items.map((item) =>
        item.id === unmatchedTrackId
          ? {
              ...item,
              id: matchedTrackId,
              album: null,
              albumName: albumTitle,
              spotifyAlbumId,
              spotifyTrackId,
              spotifyMatch: 'spotify-search',
            }
          : item,
      )
      await route.fulfill({
        response,
        json: { ...envelope, data: { ...data, items } },
      })
    },
  )

  await page.goto(
    `/tracks?view=${isMobile ? 'list' : 'table'}&q=Faraway%20Light`,
  )
  const trackLink = page.getByRole('link', { name: trackTitle, exact: true })
  const matchButton = page
    .locator('.ds-cell-id')
    .filter({ has: trackLink })
    .getByRole('button', { name: `Match ${trackTitle} to Spotify` })
  await expect(trackLink).toBeVisible()
  await expect(matchButton).toBeVisible()
  await page.getByRole('link', { name: localAlbumTitle, exact: true }).click()
  await expectAlbumOpen(page, localAlbumId, localAlbumTitle)
  await page.getByRole('button', { name: 'Close details' }).click()

  await matchButton.click()
  const dialog = page.getByRole('dialog', { name: 'Spotify track search' })
  await expect(dialog).toBeVisible()
  await dialog
    .getByRole('button', { name: `Review ${trackTitle} from ${albumTitle}` })
    .click()
  await dialog.getByRole('button', { name: 'Confirm Spotify match' }).click()
  await expect(dialog).toBeHidden()
  await expect(trackLink).toBeVisible()
  await expect(matchButton).toHaveCount(0)

  const albumLink = page.getByRole('link', { name: albumTitle, exact: true })
  await albumLink.click()
  await expectAlbumOpen(page, outsideAlbumId, albumTitle)
  await expect(
    albumDetails(page).getByRole('button', {
      name: `Add album to library · ${albumTitle}`,
    }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Close details' }).click()
  await albumLink.click()
  await expectAlbumOpen(page, outsideAlbumId, albumTitle)
  await page.getByRole('button', { name: 'Close details' }).click()

  await trackLink.click()
  const trackDetails = page.getByRole('complementary', {
    name: 'Track details',
  })
  await trackDetails
    .getByRole('link', { name: albumTitle, exact: true })
    .first()
    .click()
  await expectAlbumOpen(page, outsideAlbumId, albumTitle)
  await albumDetails(page).getByRole('button', { name: 'Back' }).click()
  await expect(trackDetails).toBeVisible()
  await page.getByRole('button', { name: 'Close details' }).click()

  const albumHref = await albumLink.getAttribute('href')
  if (!albumHref) throw new Error('The release title has no link destination')
  const albumPage = isMobile
    ? await page.context().newPage()
    : await Promise.all([
        page.context().waitForEvent('page', { timeout: 8_000 }),
        albumLink.click({ modifiers: ['ControlOrMeta'] }),
      ]).then(([newTab]) => newTab)
  try {
    if (isMobile) await albumPage.goto(new URL(albumHref, page.url()).href)
    await expect(albumPage).toHaveURL(
      (url) => url.pathname === `/albums/${outsideAlbumId}`,
    )
    await expect(
      albumPage.getByRole('heading', { name: albumTitle, exact: true }),
    ).toBeVisible()
  } finally {
    await albumPage.close()
  }
  expect(await recordOutsideAlbum(page)).toBe(outsideAlbumId)
  expect(lookups).toEqual(
    Array.from({ length: 4 }, () => ({
      trackId: matchedTrackId,
      spotifyAlbumId,
    })),
  )
  expect(searches).toEqual([])
})

test('a legacy Spotify track can retry opening its album and inspect both stored responses', async ({
  page,
}) => {
  const outsideAlbumId = await recordOutsideAlbum(page)
  await mockDirectResponseEvidence(page, outsideAlbumId)
  const searches = await blockTextSearch(page)
  await page.route(
    `${webOrigin}/api/v1/tracks/browse-page?*`,
    async (route) => {
      const response = await route.fetch()
      const envelope = await response.json()
      const data = browsePage.parse(envelope.data)
      const items = data.items.map((item) =>
        item.id === matchedTrackId
          ? { ...item, album: null, spotifyAlbumId: null }
          : item,
      )
      await route.fulfill({
        response,
        json: { ...envelope, data: { ...data, items } },
      })
    },
  )
  const lookups: unknown[] = []
  const failure = 'Spotify is temporarily unavailable. Try again.'
  let releaseFailure: () => void = () => {}
  const failedResponse = new Promise<void>((resolve) => {
    releaseFailure = resolve
  })
  let releaseSuccess: () => void = () => {}
  const successfulResponse = new Promise<void>((resolve) => {
    releaseSuccess = resolve
  })
  await page.route(resolvePath, async (route) => {
    expect(route.request().method()).toBe('POST')
    lookups.push(route.request().postDataJSON())
    if (lookups.length === 1) {
      await failedResponse
      await route.fulfill({
        status: 502,
        json: { statusCode: 502, message: failure },
      })
      return
    }
    // The preview has no live Spotify access. Simulate a successful exact
    // lookup while leaving rendering and album details on the real preview.
    await successfulResponse
    await route.fulfill({
      json: {
        statusCode: 200,
        message: 'OK',
        data: { mediaItemId: outsideAlbumId },
      },
    })
  })

  const legacyTitle = 'Hidden Letter (Edit)'
  await page.goto(`/tracks?view=list&q=${encodeURIComponent(legacyTitle)}`)
  const row = page.locator('.ds-row').filter({
    has: page.getByRole('link', { name: legacyTitle, exact: true }),
  })
  const albumLink = row.getByRole('link', { name: albumTitle, exact: true })
  await expect(
    row.getByRole('button', { name: `Match ${legacyTitle} to Spotify` }),
  ).toHaveCount(0)
  await albumLink.click()
  const loading = albumDetails(page).getByRole('status', {
    name: 'Loading album from Spotify',
  })
  try {
    await expect(loading).toBeVisible({ timeout: 3_000 })
    await expect(loading.getByText('Opening Spotify album')).toBeVisible()
  } finally {
    releaseFailure()
  }
  await expect(albumDetails(page).getByRole('alert')).toContainText(failure)
  await albumDetails(page).getByRole('button', { name: 'Retry' }).click()
  try {
    await expect(loading).toBeVisible({ timeout: 3_000 })
  } finally {
    releaseSuccess()
  }
  await expectAlbumOpen(page, outsideAlbumId, albumTitle)
  await page.getByRole('button', { name: 'Close details' }).click()
  await expect(albumDetails(page)).toHaveCount(0)
  await expect(albumLink).toBeFocused()
  await albumLink.click()
  await expectAlbumOpen(page, outsideAlbumId, albumTitle)
  const album = albumDetails(page)
  await album.getByRole('tab', { name: 'Sources' }).click()
  const albumEvidence = album.locator('details.ds-source').filter({
    has: page.getByText('Provider results', { exact: true }),
  })
  await albumEvidence.locator('summary').first().click()
  await albumEvidence.getByRole('link', { name: 'Open response' }).click()
  const albumHistory = album.getByRole('region', { name: 'Spotify history' })
  await expect(albumHistory.getByText('Direct provider response')).toBeVisible()
  const albumSnapshot = albumHistory.getByRole('region', {
    name: 'Snapshot data',
  })
  await albumSnapshot.getByText('Raw JSON', { exact: true }).click()
  await expect(albumSnapshot.locator('pre')).toContainText(spotifyAlbumId)

  const parentEvidence = album.locator('details.ds-source').filter({
    has: page.getByText('Parent link', { exact: true }),
  })
  await parentEvidence.locator('summary').first().click()
  await parentEvidence.getByRole('link', { name: 'Open response' }).click()
  const track = page.getByRole('complementary', { name: 'Track details' })
  await expect(
    track.getByRole('tab', { name: 'Sources', selected: true }),
  ).toBeVisible()
  const trackHistory = track.getByRole('region', { name: 'Spotify history' })
  await expect(trackHistory.getByText('Direct provider response')).toBeVisible()
  await expect(
    trackHistory.getByRole('link', { name: 'Job', exact: true }),
  ).toHaveCount(0)
  const trackSnapshot = trackHistory.getByRole('region', {
    name: 'Snapshot data',
  })
  await trackSnapshot.getByText('Raw JSON', { exact: true }).click()
  await expect(trackSnapshot.locator('pre')).toContainText(spotifyTrackId)
  await expect(trackSnapshot.locator('pre')).toContainText(spotifyAlbumId)
  expect(lookups).toEqual([
    { trackId: matchedTrackId },
    { trackId: matchedTrackId },
    { trackId: matchedTrackId },
  ])
  expect(searches).toEqual([])
})
