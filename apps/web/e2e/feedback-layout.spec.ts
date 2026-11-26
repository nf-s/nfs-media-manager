import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { z } from 'zod'

const styles = ['tokens', 'components']
  .map((name) =>
    readFileSync(
      resolve('../../packages/ui/src/design-system', name + '.css'),
      'utf8',
    ),
  )
  .join('\n')

test('feedback preserves compact and labelled controls and their neighbors through every phase', async ({
  page,
}) => {
  const rendered = execFileSync(
    '../server/node_modules/.bin/tsx',
    ['--tsconfig', 'tsconfig.test.json', 'e2e/fixtures/feedback-controls.tsx'],
    { encoding: 'utf8' },
  )
  const { idle, states } = z
    .object({
      idle: z.string(),
      states: z.array(
        z.object({ phase: z.string(), label: z.string(), html: z.string() }),
      ),
    })
    .parse(JSON.parse(rendered))
  await page.setContent('<style>' + styles + '</style>' + idle)
  const layout = () =>
    page.getByRole('button').evaluateAll((buttons) =>
      buttons.map((button) => {
        const { x, y, width, height } = button.getBoundingClientRect()
        return [x, y, width, height]
      }),
    )
  const resting = await layout()
  for (const state of states) {
    await page.setContent('<style>' + styles + '</style>' + state.html)
    expect(await layout(), state.phase).toEqual(resting)
    await expect(
      page.getByRole('button', { name: state.label, exact: true }),
    ).toHaveCount(2)
    await expect(
      page.getByRole('button', {
        name: state.label + ' · Refresh',
        exact: true,
      }),
    ).toBeVisible()
  }
})
