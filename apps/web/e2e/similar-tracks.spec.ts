import { expect, test, type Locator, type Page } from '@playwright/test'
import { z } from 'zod'
import { TidalSimilarSchema } from '@repo/schemas/tidal'

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
  await page.goto('/tracks?view=list&q=Hidden+Letter')
  await page.getByRole('link', { name: 'Hidden Letter', exact: true }).click()
  await page.getByRole('tab', { name: 'Similar', exact: true }).click()
}

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
