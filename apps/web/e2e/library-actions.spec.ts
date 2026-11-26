import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import {
  ManualMediaAddInputSchema,
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
  const dataPath = `${webOrigin}/api/v1${detailPath}`
  const outside = await page.request.get(dataPath)
  expect(outside.ok()).toBe(true)
  const outsideDetail = await outside.json()
  let staleDetail = true
  await page.route(dataPath, (route) =>
    staleDetail ? route.fulfill({ json: outsideDetail }) : route.continue(),
  )
  await page.goto(detailPath)
  const heading = page.getByRole('heading', { name: title, exact: true })
  const add = page.getByRole('button', {
    name: `Add track to library · ${title}`,
  })
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let writes = 0
  await page.route(
    `${webOrigin}/api/v1/catalog/media/${track.item.id}/add`,
    async (route) => {
      writes += 1
      await held
      await route.continue()
    },
  )
  await expect(heading).toBeVisible()
  await expect(add).toBeEnabled()
  await page.evaluate(async () => {
    await document.fonts.ready
  })
  const idle = await add.boundingBox()
  expect(idle).not.toBeNull()
  await add.press('Enter')
  const receipt = page.locator('.ds-library-action')
  try {
    await expect(receipt).toHaveText('Adding…', { useInnerText: true })
    expect(await receipt.boundingBox()).toEqual(idle)
    await expect(receipt).toHaveAttribute('aria-busy', 'true')
    await receipt.dispatchEvent('click')
    expect(writes).toBe(1)
  } finally {
    release()
  }
  await expect(receipt).toHaveText('Added', { useInnerText: true })
  expect(await receipt.boundingBox()).toEqual(idle)
  await expect(receipt).toHaveAttribute('data-feedback', 'done')
  await expect(
    page.getByText(`Added track to library · ${title}`, { exact: true }),
  ).toHaveCount(0)
  await expect(receipt).toHaveCount(0)
  expect(writes).toBe(1)
  staleDetail = false
  await page.reload()
  await expect(page).toHaveURL((url) => url.pathname === detailPath)
  await expect(heading).toBeVisible()
  await expect(
    page.getByRole('button', { name: /is in your library/ }),
  ).toHaveCount(0)
  await expect(page.locator('.ds-library-action')).toHaveCount(0)
})

test('independent manual rows send and receive their own addition receipts', async ({
  page,
}) => {
  const choices = [
    {
      externalId: '0000000000000000000101',
      title: 'First synthetic recording',
    },
    {
      externalId: '0000000000000000000102',
      title: 'Second synthetic recording',
    },
  ]
  const releases = new Map<string, () => void>()
  const pending = new Map(
    choices.map(({ externalId }) => [
      externalId,
      new Promise<void>((resolve) => {
        releases.set(externalId, resolve)
      }),
    ]),
  )
  const writes = new Set<string>()
  await page.route(`${webOrigin}/api/v1/manual-add/search`, (route) =>
    route.fulfill({
      json: {
        statusCode: 200,
        message: 'OK',
        data: {
          items: choices.map(({ externalId, title }) => ({
            externalId,
            title,
            subtitle: null,
            mediaItemId: null,
            catalogMediaItemId: `fixture-${externalId}`,
            releaseDate: null,
            artworkUrl: null,
            url: `https://open.spotify.com/track/${externalId}`,
          })),
          page: 1,
          hasMore: false,
        },
      },
    }),
  )
  await page.route(`${webOrigin}/api/v1/manual-add/add`, async (route) => {
    const input = ManualMediaAddInputSchema.parse(
      route.request().postDataJSON(),
    )
    writes.add(input.externalId)
    await pending.get(input.externalId)
    await route.fulfill({
      json: {
        statusCode: 200,
        message: 'OK',
        data: { mediaItemId: `fixture-${input.externalId}`, created: true },
      },
    })
  })
  await page.goto('/tracks')
  await page.getByRole('button', { name: 'Add track', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add track' })
  await dialog
    .getByRole('textbox', { name: 'Search Spotify' })
    .fill('synthetic')
  await dialog.getByRole('button', { name: 'Search', exact: true }).click()
  const [first, second] = choices
  if (!first || !second) throw new Error('Both fixture choices are required')
  const action = (title: string) =>
    dialog
      .locator('.ds-library-action')
      .and(dialog.getByRole('button', { name: new RegExp(title) }))
  try {
    await action(first.title).click()
    await expect(action(first.title)).toHaveText('Adding…', {
      useInnerText: true,
    })
    await expect(action(second.title)).toBeEnabled()
    await action(second.title).click()
    await expect(action(second.title)).toHaveText('Adding…', {
      useInnerText: true,
    })
    releases.get(first.externalId)?.()
    await expect(action(first.title)).toHaveText('Added', {
      useInnerText: true,
    })
    await expect(action(second.title)).toHaveText('Adding…', {
      useInnerText: true,
    })
    releases.get(second.externalId)?.()
    await expect(dialog).not.toBeVisible()
    await expect(
      page.getByText(`Added track to library · ${second.title}`, {
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      page.getByText(`Added track to library · ${first.title}`, {
        exact: true,
      }),
    ).toHaveCount(0)
    await expect(page).toHaveURL(
      (url) =>
        url.searchParams.get('inspect')?.includes(second.externalId) === true,
    )
    expect(writes).toEqual(new Set(choices.map(({ externalId }) => externalId)))
  } finally {
    for (const release of releases.values()) release()
  }
})

test('a rejected library addition leaves the same control available for retry', async ({
  page,
}) => {
  const title = `Synthetic retry track ${randomBytes(4).toString('hex')}`
  const observation = await page.request.post(
    `${webOrigin}/api/v1/playback/catalog`,
    {
      headers: { origin: webOrigin },
      data: PlaybackCatalogInputSchema.parse({
        operation: 'playback',
        items: [
          {
            kind: 'track',
            spotifyId: `zz${randomBytes(10).toString('hex')}`,
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
  let writes = 0
  await page.route(
    `${webOrigin}/api/v1/catalog/media/${track.item.id}/add`,
    async (route) => {
      writes += 1
      if (writes === 1) {
        await route.fulfill({
          status: 409,
          json: {
            statusCode: 409,
            message: 'Synthetic write conflict',
            data: null,
          },
        })
      } else await route.continue()
    },
  )
  await page.goto(`/tracks/${track.item.id}`)
  const receipt = page.locator('.ds-library-action')
  await receipt.click()
  await expect(receipt).toHaveText('Add failed · retry', { useInnerText: true })
  await expect(receipt).toBeEnabled()
  await receipt.click()
  await expect(receipt).toHaveText('Added', { useInnerText: true })
  expect(writes).toBe(2)
})

test('an interrupted library response stays unconfirmed until an idempotent retry', async ({
  page,
}) => {
  const title = `Synthetic interrupted track ${randomBytes(4).toString('hex')}`
  const observation = await page.request.post(
    `${webOrigin}/api/v1/playback/catalog`,
    {
      headers: { origin: webOrigin },
      data: PlaybackCatalogInputSchema.parse({
        operation: 'playback',
        items: [
          {
            kind: 'track',
            spotifyId: `zz${randomBytes(10).toString('hex')}`,
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
  let writes = 0
  await page.route(
    `${webOrigin}/api/v1/catalog/media/${track.item.id}/add`,
    async (route) => {
      writes += 1
      if (writes === 1) {
        const saved = await route.fetch()
        expect(saved.ok()).toBe(true)
        await route.abort('connectionclosed')
      } else await route.continue()
    },
  )
  await page.goto(`/tracks/${track.item.id}`)
  const receipt = page.locator('.ds-library-action')
  await receipt.click()
  await expect(receipt).toHaveAttribute('data-feedback', 'unconfirmed')
  await expect(receipt).toHaveText('Add unconfirmed · retry', {
    useInnerText: true,
  })
  await receipt.click()
  await expect(receipt).toHaveText('Added', { useInnerText: true })
  expect(writes).toBe(2)
  await page.reload()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  await expect(receipt).toHaveCount(0)
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
    list.getByRole('link', { name: title, exact: true }),
  ).toHaveAttribute('data-workspace-href', `/albums/${savedId}`)
  await expect(
    list.getByRole('button', { name: new RegExp(`Added.*${title}`) }),
  ).toHaveText('Added', { useInnerText: true })
  await expect(
    page.getByText(`Added album to library · ${title}`, { exact: true }),
  ).toHaveCount(0)
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
