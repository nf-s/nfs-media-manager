import { expect, test } from '@playwright/test'

test('saving a limit and revoking a fixture key each confirm the change once', async ({
  page,
}) => {
  let key = {
    id: 'fixture-key',
    name: 'Fixture key',
    start: 'fixture',
    createdAt: '2026-01-01T00:00:00Z',
    expiresAt: null,
    lastRequest: null,
    enabled: true,
    requestsUsed: null,
    rateLimit: { enabled: false },
  }
  let saves = 0
  let reply: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    reply = resolve
  })
  await page.route('**/api/v1/user/api-keys', (route) =>
    route.fulfill({
      json: { statusCode: 200, message: 'OK', data: [key] },
    }),
  )
  await page.route('**/api/v1/user/api-keys/fixture-key', async (route) => {
    if (route.request().method() === 'DELETE') key = { ...key, enabled: false }
    if (route.request().method() === 'PATCH' && ++saves === 2) await held
    return route.fulfill({
      json: { statusCode: 200, message: 'OK', data: key },
    })
  })
  await page.goto('/user')
  const edit = page.getByRole('button', {
    name: /Edit rate limit for Fixture key/,
  })
  await edit.click()
  await page.getByRole('button', { name: 'Save limit', exact: true }).click()
  await expect(
    page.getByRole('button', {
      name: 'Limit saved · Edit rate limit for Fixture key',
    }),
  ).toBeVisible()
  await expect(page.getByText('Rate limit saved.')).toBeHidden()

  const search = page.getByRole('searchbox', { name: 'Search API keys' })
  await edit.click()
  await page.getByRole('button', { name: 'Save limit', exact: true }).click()
  try {
    await search.fill('No matching fixture')
    await expect(edit).toBeHidden()
  } finally {
    reply()
  }
  await expect(page.getByText('Rate limit saved.')).toBeVisible()
  await search.clear()
  await expect(edit).toBeVisible()
  await expect(page.getByText('Rate limit saved.')).toBeHidden()
  await page.getByRole('button', { name: 'Revoke Fixture key' }).click()
  await page
    .getByRole('dialog', { name: 'Revoke Fixture key?' })
    .getByRole('button', { name: 'Revoke', exact: true })
    .click()
  await expect(page.getByText('Revoked', { exact: true })).toHaveCount(1)
  await expect(page.getByText('API key revoked.')).toBeHidden()
})
