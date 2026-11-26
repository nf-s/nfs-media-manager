import { expect, test } from '@playwright/test'

for (const library of ['film', 'album']) {
  test(`${library} Ranking shows its native source columns in order through Year`, async ({
    page,
  }, info) => {
    const desktop = info.project.name === 'desktop'
    if (desktop) await page.setViewportSize({ width: 1360, height: 812 })
    await page.goto('/' + library + 's/ratings')
    const table = page.getByRole('table', {
      name: library === 'film' ? 'Film rankings' : 'Album rankings',
    })
    await expect(
      table
        .getByRole('button', { name: /^Combined score calculation/ })
        .first(),
    ).toBeVisible()
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    const headers = table.getByRole('columnheader')
    const film = library === 'film'
    await expect(headers).toHaveText([
      ...(film ? ['#', 'Film'] : ['Album', 'Playback', '#']),
      'Score',
      'Spread',
      'Counted',
      'Furthest',
      'Crit − aud',
      ...(film
        ? [
            'Mine − score',
            'Mine',
            'IMDb',
            'TMDb',
            'Trakt',
            'Lbxd',
            'RT aud',
            'MC users',
            'RT',
            'Meta',
          ]
        : ['RYM', 'Discogs', 'Meta']),
      'Year',
      ...(film ? ['Director'] : []),
      'Tags',
    ])
    const clippedValues = await table
      .locator('.ds-rating-difference')
      .evaluateAll(
        (buttons) =>
          buttons.filter((button) => {
            const cell = button.closest('td')
            return !cell || cell.scrollWidth > cell.clientWidth
          }).length,
      )
    expect(clippedValues).toBe(0)
    if (desktop) {
      const year = headers.filter({
        has: page.getByRole('button', { name: 'Year', exact: true }),
      })
      const visibleAtRest = await year.evaluate((cell) => {
        const region = cell.closest('[role="region"]')
        return (
          region &&
          region.scrollLeft === 0 &&
          cell.getBoundingClientRect().right <=
            region.getBoundingClientRect().right
        )
      })
      expect(visibleAtRest).toBe(true)
    }
    const abbreviated = headers.filter({
      has: page.getByRole('button', {
        name: film ? 'Lbxd' : 'Meta',
        exact: true,
      }),
    })
    const sort = abbreviated.getByRole('button')
    await expect(sort).toHaveAttribute(
      'title',
      film ? /Letterboxd/i : /Metacritic/i,
    )
    await sort.click()
    await expect(abbreviated).toHaveAttribute(
      'aria-sort',
      /^(ascending|descending)$/,
    )
  })
}
