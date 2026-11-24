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
  await expect(add).toHaveCount(0)
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: `Added track to library · ${title}` }),
  ).toHaveAttribute('aria-atomic', 'true')
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
