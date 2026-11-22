import { expect, test as setup } from '@playwright/test'
import { apiOrigin, authFile } from './preview'

setup('sign in to the preview', async ({ page }) => {
  await page.goto(`${apiOrigin}/preview/sign-in?next=/tracks`)
  await expect(page).toHaveURL(/\/tracks$/)
  await page.context().storageState({ path: authFile })
})
