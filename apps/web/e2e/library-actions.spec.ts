import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import {
  ManualMediaSearchInputSchema,
  type ManualMediaSearchItem,
} from '@repo/schemas/manual-add'
import {
  PlaybackCatalogInputSchema,
  PlaybackCatalogResultSchema,
} from '@repo/schemas/playback'
import { TidalSimilarSchema } from '@repo/schemas/tidal'
import { webOrigin } from './preview'

const catalogs = [
  {
    kind: 'track',
    path: '/tracks',
    provider: 'Spotify',
    savedId: '0000000000000000000001',
    missingId: '0000000000000000000002',
  },
  {
    kind: 'album',
    path: '/albums',
    provider: 'Spotify',
    savedId: '0000000000000000000003',
    missingId: '0000000000000000000004',
  },
  {
    kind: 'film',
    path: '/films',
    provider: 'TMDb',
    savedId: '9101',
    missingId: '9102',
  },
]

for (const { kind, path, provider, savedId, missingId } of catalogs) {
  test(`${kind} catalog results show Add only for the missing item`, async ({
    page,
  }) => {
    const existingName = `Saved fixture ${kind}`
    const missingName = `Missing fixture ${kind}`
    const item = (
      title: string,
      externalId: string,
      mediaItemId: string | null,
    ): ManualMediaSearchItem => ({
      title,
      externalId,
      mediaItemId,
      catalogMediaItemId: `catalog-${externalId}`,
      subtitle: null,
      releaseDate: null,
      artworkUrl: null,
      url:
        kind === 'film'
          ? `https://www.themoviedb.org/movie/${externalId}`
          : `https://open.spotify.com/${kind}/${externalId}`,
    })
    const items = [
      item(existingName, savedId, `saved-${savedId}`),
      item(missingName, missingId, null),
    ]
    const addRequests: string[] = []
    await page.route(`${webOrigin}/api/v1/manual-add/add`, async (route) => {
      addRequests.push(route.request().method())
      await route.abort()
    })
    await page.route(`${webOrigin}/api/v1/manual-add/search`, async (route) => {
      const input = ManualMediaSearchInputSchema.parse(
        route.request().postDataJSON(),
      )
      expect(input).toMatchObject({ mediaType: kind, exactMembership: true })
      await route.fulfill({
        json: {
          statusCode: 200,
          message: 'OK',
          data: { items, page: 1, hasMore: false },
        },
      })
    })
    await page.goto(path)
    await page.getByRole('button', { name: `Add ${kind}`, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: `Add ${kind}` })
    await dialog
      .getByRole('textbox', { name: `Search ${provider}` })
      .fill('fixture')
    await dialog.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(
      dialog.getByRole('link', { name: existingName, exact: true }),
    ).toHaveAttribute('data-workspace-href', `${path}/saved-${savedId}`)
    await expect(
      dialog.getByRole('link', { name: missingName, exact: true }),
    ).toHaveAttribute('data-workspace-href', `${path}/catalog-${missingId}`)
    await expect(
      dialog.getByRole('button', {
        name: `Add ${kind} to library · ${missingName}`,
      }),
    ).toBeEnabled()
    await expect(
      dialog.getByRole('button', {
        name: /is in your library/,
      }),
    ).toHaveCount(0)
    await expect(dialog.locator('.ds-library-action')).toHaveCount(1)
    if (kind === 'album') {
      await dialog.getByRole('link', { name: missingName, exact: true }).click()
      await expect(dialog).not.toBeVisible()
      await expect(page).toHaveURL((url) =>
        Boolean(
          url.searchParams.get('inspect')?.includes(`catalog-${missingId}`),
        ),
      )
      expect(addRequests).toEqual([])
    }
  })
}

test('an outside track can be added from its detail page and stays saved on reload', async ({
  page,
  isMobile,
}) => {
  const spotifyId = `zz${randomBytes(10).toString('hex')}`
  const title = `Synthetic outside track for ${isMobile ? 'phone' : 'desktop'} ${spotifyId.slice(-6)}`
  const observation = await page.request.post(
    `${webOrigin}/api/v1/playback/catalog`,
    {
      headers: { origin: webOrigin },
      data: PlaybackCatalogInputSchema.parse({
        operation: 'playback',
        items: [
          {
            kind: 'track',
            spotifyId,
            title,
            artists: [{ name: 'Synthetic catalog artist' }],
          },
        ],
      }),
    },
  )
  expect(observation.ok()).toBe(true)
  const { data } = await observation.json()
  const [track] = PlaybackCatalogResultSchema.parse(data).items
  if (!track) throw new Error('The preview did not record the synthetic track')
  expect(track.item.inLibrary).toBe(false)

  const detailPath = `/tracks/${track.item.id}`
  await page.goto(detailPath)
  const heading = page.getByRole('heading', { name: title, exact: true })
  const add = page.getByRole('button', {
    name: `Add track to library · ${title}`,
  })
  await expect(heading).toBeVisible()
  await expect(add).toBeEnabled()
  await add.click()
  await expect(
    page.getByRole('status').filter({
      hasText: `Added track to library · ${title}`,
    }),
  ).toHaveAttribute('aria-atomic', 'true')
  await expect(page.locator('.ds-library-action')).toHaveCount(0)
  await page.reload()
  await expect(page).toHaveURL((url) => url.pathname === detailPath)
  await expect(heading).toBeVisible()
  await expect(
    page.getByRole('button', { name: /is in your library/ }),
  ).toHaveCount(0)
  await expect(page.locator('.ds-library-action')).toHaveCount(0)
})

test('Similar keeps a saved album title and its match evidence without an Add control', async ({
  page,
}) => {
  const parentId = 'pv-album-01'
  const savedId = 'pv-album-02'
  const title = 'Synthetic related album'
  const tidalId = '930020'
  const similarPath = `${webOrigin}/api/v1/tidal/similar/albums/${parentId}`
  let saved = false
  await page.route(similarPath, async (route) => {
    const data = TidalSimilarSchema.parse({
      kind: 'album',
      itemId: parentId,
      matched: true,
      matchJob: null,
      unmatched: null,
      job: null,
      lookupJob: null,
      readAt: '2026-11-20T00:00:00.000Z',
      source: null,
      items: [
        {
          tidalId,
          title,
          version: null,
          artists: ['Synthetic artist'],
          code: null,
          durationSec: null,
          releaseDate: '2025-10-04',
          url: `https://tidal.com/browse/album/${tidalId}`,
          state: saved ? 'library' : 'none',
          spotify: null,
          library: saved
            ? {
                id: savedId,
                title,
                artworkUrl: null,
                spotifyId: null,
                album: null,
                albumName: null,
                trackCount: null,
              }
            : null,
          libraryMatch: saved ? { basis: 'tidal-id', value: tidalId } : null,
        },
      ],
    })
    await route.fulfill({ json: { statusCode: 200, message: 'OK', data } })
  })
  await page.route(`${similarPath}/${tidalId}/library`, async (route) => {
    expect(route.request().method()).toBe('POST')
    saved = true
    await route.fulfill({
      json: { statusCode: 200, message: 'OK', data: { id: savedId } },
    })
  })
  await page.goto(`/albums/${parentId}`)
  const similar = page.getByRole('tab', { name: 'Similar' })
  await similar.click()
  const list = page.locator('[aria-label="Similar albums"]')
  await list
    .getByRole('button', { name: `Add album to library · ${title}` })
    .click()
  await expect(
    page.getByRole('status').filter({
      hasText: `Added album to library · ${title}`,
    }),
  ).toHaveAttribute('aria-atomic', 'true')
  await expect(
    list.getByRole('link', { name: title, exact: true }),
  ).toHaveAttribute('data-workspace-href', `/albums/${savedId}`)
  await expect(list.locator('.ds-library-action')).toHaveCount(0)
  await page.reload()
  await similar.click()
  await expect(list.getByRole('link', { name: 'In library' })).toHaveAttribute(
    'data-workspace-href',
    `/albums/${savedId}?tab=sources`,
  )
  await expect(
    list.getByRole('button', { name: /is in your library/ }),
  ).toHaveCount(0)
  await expect(list.locator('.ds-library-action')).toHaveCount(0)
  await list.getByRole('link', { name: 'In library' }).click()
  await expect(page).toHaveURL((url) =>
    Boolean(url.searchParams.get('inspect')?.includes(savedId)),
  )
  await expect(
    page.getByRole('tab', { name: 'Sources', selected: true }),
  ).toBeVisible()
})
