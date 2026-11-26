import { expect, test } from '@playwright/test'
import { webOrigin } from './preview'

test('setting the shown version keeps the radio and its neighboring action in place', async ({
  page,
}) => {
  const trackId = 'track_3c533604ddc8e1666b42'
  const versions = ['Original fixture', 'Other fixture'].map(
    (title, index) => ({
      id: index === 0 ? trackId : 'fixture-alternate',
      type: 'lastfm',
      title,
      by: 'Fixture artist',
      album: null,
      albumName: null,
      durationSec: 200,
      scrobbles: 0,
      shown: index === 0,
    }),
  )
  await page.route(`${webOrigin}/api/v1/tracks/${trackId}/parts`, (route) =>
    route.fulfill({
      json: {
        statusCode: 200,
        message: 'OK',
        data: {
          shownId: trackId,
          stored: true,
          scrobbles: 0,
          versions,
          names: [],
        },
      },
    }),
  )
  let reply: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    reply = resolve
  })
  await page.route(
    '**/api/v1/library-changes/track-versions/shown',
    async (route) => {
      await held
      await route.fulfill({
        status: 409,
        json: { statusCode: 409, message: 'Fixture conflict' },
      })
    },
  )

  await page.goto(`/tracks/${trackId}?tab=sources`)
  const row = page.getByRole('table', { name: 'Made of' }).getByRole('row', {
    name: /Other fixture/,
  })
  const radio = row.getByRole('radio', { name: 'Show as Other fixture' })
  await radio.scrollIntoViewIfNeeded()
  const layout = () =>
    row.evaluate((element) => {
      const origin = element.getBoundingClientRect()
      return Array.from(
        element.querySelectorAll('input, button'),
        (control) => {
          const { x, y, width, height } = control.getBoundingClientRect()
          return [x - origin.x, y - origin.y, width, height]
        },
      ).concat([[origin.width, origin.height]])
    })
  const resting = await layout()
  await radio.click()
  try {
    await expect(radio).toHaveAttribute('aria-busy', 'true')
    expect(await layout()).toEqual(resting)
  } finally {
    reply()
  }
  await expect(radio).toHaveAttribute('title', 'Could not set shown version')
  expect(await layout()).toEqual(resting)
})
