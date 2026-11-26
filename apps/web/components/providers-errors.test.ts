import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toast } from '@repo/ui/components/ui/sonner'
import { queryClient } from './providers'

test('an error without an inline alert produces a single fallback with its cause', async () => {
  const message = 'Fixture request failed.'
  await assert.rejects(
    queryClient.fetchQuery({
      queryKey: ['fixture-error'],
      retry: false,
      queryFn: () => {
        throw new Error(message, { cause: 'Fixture connection closed.' })
      },
    }),
  )
  const receipts = toast
    .getHistory()
    .filter((item) => 'title' in item && item.title === message)
  assert.equal(receipts.length, 1)
  assert.ok(receipts[0] && 'description' in receipts[0])
  assert.equal(receipts[0].description, 'Fixture connection closed.')
  queryClient.clear()
})
