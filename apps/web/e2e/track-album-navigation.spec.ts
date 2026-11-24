import { expect, test, type Page } from '@playwright/test'
import { BrowsePageSliceSchema } from '@repo/schemas/browse'
import {
  PlaybackCatalogInputSchema,
  PlaybackCatalogResultSchema,
} from '@repo/schemas/playback'
import {
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
  return page.getByLabel('Album details', { exact: true })
}

async function expectAlbumOpen(page: Page, id: string, title: string) {
  await expect(page).toHaveURL((url) =>
    Boolean(url.searchParams.get('inspect')?.includes(id)),
  )
  await expect(
    albumDetails(page).getByRole('heading', { name: title, exact: true }),
  ).toBeVisible()
}

test('a saved track offers manual Spotify matching in its title and opens the exact release after matching', async ({
  page,
  isMobile,
}) => {
  const outsideAlbumId = await recordOutsideAlbum(page)
  const searches = await blockTextSearch(page)
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

  const albumHref = await albumLink.getAttribute('href')
  if (!albumHref) throw new Error('The release title has no link destination')
  const albumPage = await page.context().newPage()
  try {
    await albumPage.goto(new URL(albumHref, page.url()).href)
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
  expect(searches).toEqual([])
})

test('an album with only a matched Spotify track ID can open by ID after a failed attempt', async ({
  page,
}) => {
  const outsideAlbumId = await recordOutsideAlbum(page)
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
  const failure = 'Could not load this Spotify release. Try again.'
  await page.route(resolvePath, async (route) => {
    expect(route.request().method()).toBe('POST')
    lookups.push(route.request().postDataJSON())
    if (lookups.length === 1) {
      await route.fulfill({
        status: 502,
        json: { statusCode: 502, message: failure },
      })
      return
    }
    // The preview has no live Spotify access. Simulate a successful exact
    // lookup while leaving rendering and album details on the real preview.
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
  await expect(row.getByRole('alert')).toHaveText(failure)
  await expect(albumDetails(page)).toHaveCount(0)
  await albumLink.click()
  await expectAlbumOpen(page, outsideAlbumId, albumTitle)
  expect(lookups).toEqual([
    { trackId: matchedTrackId },
    { trackId: matchedTrackId },
  ])
  expect(searches).toEqual([])
})
