import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { ManualMediaAddResultSchema } from '@repo/schemas/manual-add'
import {
  PlaybackCatalogInputSchema,
  PlaybackCatalogResultSchema,
} from '@repo/schemas/playback'
import {
  applyFieldFilter,
  readCount,
  selectRows,
  urlFilters,
  webOrigin,
} from './preview'

const filteredCount = /^[\d,]+ of [\d,]+ tracks$/

test('voice search shows microphone permission on the action and preserves the input', async ({
  page,
}) => {
  await page.route('**/api/v1/ai/status', (route) =>
    route.fulfill({
      json: {
        statusCode: 200,
        message: 'OK',
        data: { available: true, reason: null },
      },
    }),
  )
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: () => new Promise<MediaStream>(() => {}),
    })
  })
  await page.goto('/tracks')
  const input = page.getByRole('combobox', {
    name: 'Search and filter library',
  })
  await input.fill('example request')
  await page.getByRole('button', { name: 'Record search', exact: true }).click()
  await expect(
    page.getByRole('button', { name: /Allow microphone access/ }),
  ).toBeVisible()
  await expect(input).toHaveValue('example request')
  await expect(
    page.getByText('Allow microphone access…', { exact: true }),
  ).toHaveCount(1)
  await page.getByRole('button', { name: 'Cancel recording' }).click()
})

test('Possible duplicates shows the server read without resizing its toggle', async ({
  page,
}) => {
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/v1/tracks/duplicates/count', (route) =>
    route.fulfill({
      json: { statusCode: 200, message: 'OK', data: { ready: true, count: 2 } },
    }),
  )
  await page.route('**/api/v1/tracks/duplicates/layout?*', async (route) => {
    await held
    await route.continue()
  })
  await page.goto('/tracks/matches')
  const toggle = page.getByRole('button', { name: /Possible duplicates/ })
  await expect(toggle.locator('.ds-count')).toHaveText('2')
  const idle = await toggle.boundingBox()
  expect(idle).not.toBeNull()
  try {
    await toggle.click()
    await expect(toggle).toHaveText('Updating…', { useInnerText: true })
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(await toggle.boundingBox()).toMatchObject({
      width: idle?.width,
      height: idle?.height,
    })
  } finally {
    release()
  }
  await expect(toggle).toHaveText('Results updated', { useInnerText: true })
  expect(await toggle.boundingBox()).toMatchObject({
    width: idle?.width,
    height: idle?.height,
  })
})

test('Tracks Browse filters by a field, selects rows and keeps the filter on reload', async ({
  page,
}) => {
  await page.goto('/tracks')
  await expect(page.getByText(/^[\d,]+ tracks$/)).toBeVisible()

  await applyFieldFilter(page, 'Halden', 'Artists: Halden Row')
  await expect(
    page.getByRole('button', { name: 'Remove Halden Row filter' }),
  ).toBeVisible()
  expect(urlFilters(page)).toEqual([{ field: 'artist', value: 'Halden Row' }])
  await expect(page.getByText(filteredCount)).toBeVisible()
  const [matching = 0, total = 0] = await readCount(page, filteredCount)
  expect(matching).toBeGreaterThan(1)
  expect(matching).toBeLessThan(total)

  await selectRows(page, 2, matching)

  await page.reload()
  expect(urlFilters(page)).toEqual([{ field: 'artist', value: 'Halden Row' }])
  await expect(
    page.getByRole('button', { name: 'Remove Halden Row filter' }),
  ).toBeVisible()
  await expect(
    page.getByText(
      `${matching.toLocaleString('en')} of ${total.toLocaleString('en')} tracks`,
    ),
  ).toBeVisible()
  await selectRows(page, 1, matching)
})

test('Tracks Browse ignores listen and playback discovery filters in saved links', async ({
  page,
}) => {
  const params = new URLSearchParams({
    libraryScope: 'all',
    discoverySources:
      'playback,playback-queue,playback-recovery,scrobble,similar',
  })
  await page.goto(`/tracks?${params}`)
  await expect(
    page.getByRole('button', {
      name: 'Remove discovery source Similar results',
    }),
  ).toBeVisible()
  await page
    .getByRole('button', {
      name: /filters, columns and grid size, 1 filter on/i,
    })
    .click()
  await page.getByText('Discovery sources', { exact: true }).click()
  await expect(
    page.getByRole('checkbox', { name: 'Similar results', exact: true }),
  ).toBeChecked()
  for (const name of [
    'Playback',
    'Playback queue',
    'Recently played',
    'Listening history',
    'Film details',
    'Find match',
  ]) {
    await expect(page.getByRole('checkbox', { name, exact: true })).toHaveCount(
      0,
    )
  }
})

test('Tracks Browse adds an outside track from its title cell', async ({
  page,
}) => {
  const spotifyId = `zz${randomBytes(10).toString('hex')}`
  const title = `Browse outside ${spotifyId.slice(-6)}`
  const headers = { origin: webOrigin }
  const observation = await page.request.post(
    `${webOrigin}/api/v1/playback/catalog`,
    {
      headers,
      data: PlaybackCatalogInputSchema.parse({
        operation: 'playback',
        items: [
          {
            kind: 'track',
            spotifyId,
            title,
            artists: [{ name: 'Synthetic Browse artist' }],
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
  const id = track.item.id
  const addUrl = `${webOrigin}/api/v1/catalog/media/${encodeURIComponent(id)}/add`
  const titleLink = page.getByRole('link', { name: title, exact: true })
  const add = page.getByRole('button', {
    name: `Add track to library · ${title}`,
  })
  const outsidePath = (view: string) =>
    `/tracks?${new URLSearchParams({ view, libraryScope: 'all', q: title })}`

  for (const view of ['grid', 'list']) {
    await page.goto(outsidePath(view))
    await expect(titleLink).toBeVisible()
    await expect(add).toBeEnabled()
  }

  await page.goto(outsidePath('table'))
  const titleCell = page.getByRole('cell').filter({ has: titleLink })
  await expect(
    titleCell.getByRole('button', { name: `Add track to library · ${title}` }),
  ).toBeEnabled()
  await expect(titleLink).toHaveAttribute(
    'data-workspace-href',
    `/tracks/${id}`,
  )
  let adds = 0
  page.on('request', (request) => {
    if (request.url() === addUrl && request.method() === 'POST') adds += 1
  })
  const response = page.waitForResponse(addUrl)
  await add.click()
  const saved = await response
  expect(saved.ok()).toBe(true)
  expect(ManualMediaAddResultSchema.parse((await saved.json()).data)).toEqual({
    created: true,
    mediaItemId: id,
  })
  await expect(titleCell.locator('.ds-library-action')).toHaveText('Added', {
    useInnerText: true,
  })
  await expect(add).toHaveCount(0)
  await expect(
    page.getByText(`Added track to library · ${title}`, { exact: true }),
  ).toHaveCount(0)
  expect(new URL(page.url()).searchParams.get('inspect')).toBeNull()
  expect(adds).toBe(1)

  await page.reload()
  await expect(titleLink).toBeVisible()
  await expect(add).toHaveCount(0)

  await page.goto(`/tracks?${new URLSearchParams({ view: 'table', q: title })}`)
  await expect(titleLink).toBeVisible()
  await expect(add).toHaveCount(0)
  await titleLink.click()
  await expect(page).toHaveURL(
    (url) => url.searchParams.get('inspect')?.includes(id) === true,
  )
  await expect(
    page.getByRole('heading', { name: title, exact: true }),
  ).toBeVisible()
  expect(adds).toBe(1)

  const repeat = await page.request.post(addUrl, { headers })
  expect(repeat.ok()).toBe(true)
  expect(ManualMediaAddResultSchema.parse((await repeat.json()).data)).toEqual({
    created: false,
    mediaItemId: id,
  })
})
