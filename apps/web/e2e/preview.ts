import { expect, type Page } from '@playwright/test'

// The preview command's default ports, or the ones given to both.
export const previewPorts = {
  web: Number(process.env.PREVIEW_WEB_PORT ?? 3710),
  api: Number(process.env.PREVIEW_API_PORT ?? 4710),
}
export const webOrigin = `http://127.0.0.1:${previewPorts.web}`
export const apiOrigin = `http://127.0.0.1:${previewPorts.api}`
export const authFile = '.playwright/preview-session.json'

/** Searches with the shared search control and applies a field suggestion. */
export async function applyFieldFilter(
  page: Page,
  text: string,
  suggestion: string,
) {
  const search = page.getByRole('combobox', {
    name: 'Search and filter library',
  })
  await search.fill(text)
  await page
    .getByRole('listbox', { name: 'Filter suggestions' })
    .getByRole('option')
    .filter({ hasText: suggestion })
    .first()
    .click()
  // The suggestions stay open for further filters; close them once the
  // filter has been applied.
  await expect(async () => {
    await search.press('Escape')
    await expect(search).toHaveAttribute('aria-expanded', 'false', {
      timeout: 1_000,
    })
  }).toPass()
}

/** The field filters in the page URL. */
export function urlFilters(page: Page): unknown {
  return JSON.parse(new URL(page.url()).searchParams.get('filters') ?? '[]')
}

/** A count such as "77 tracks" or "77 of 642 tracks", as numbers. */
export async function readCount(page: Page, pattern: RegExp) {
  const text = await page.getByText(pattern).first().textContent()
  const numbers = (text ?? '').match(/[\d,]+/g) ?? []
  return numbers.map((value) => Number(value.replaceAll(',', '')))
}

/** Ticks the first rows that can be selected and checks the selection bar. */
export async function selectRows(page: Page, count: number, of: number) {
  const boxes = page
    .getByRole('checkbox', { name: /^Select (?!all |loaded )/ })
    .and(page.locator(':enabled'))
  for (let index = 0; index < count; index += 1) await boxes.nth(index).check()
  await expect(
    page.getByText(
      new RegExp(`^${count} selected of ${of.toLocaleString('en')}\\b`),
    ),
  ).toBeVisible()
}
