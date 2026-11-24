import { expect, test, type Locator } from '@playwright/test'
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
    await page.goto('/tracks?view=list&q=Hidden+Letter')
    await page.getByRole('link', { name: 'Hidden Letter', exact: true }).click()
    await page.getByRole('tab', { name: 'Similar', exact: true }).click()
    await expect(
      page.getByText('Received from TIDAL · updating library matches'),
    ).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Tidal Basin Edit' }),
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
  await page.goto('/tracks?view=list&q=Hidden+Letter')
  await page.getByRole('link', { name: 'Hidden Letter', exact: true }).click()
  await page.getByRole('tab', { name: 'Similar', exact: true }).click()

  const row = page
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
