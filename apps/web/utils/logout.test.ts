import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QueryClient } from '@tanstack/react-query'
import { clearSessionData } from './logout'

test('logout cancels pending reads and clears query and mutation data before navigation', async () => {
  const client = new QueryClient()
  client.setQueryData(['albums'], ['private album'])
  const mutation = client.getMutationCache().build(client, {
    mutationFn: async () => 'private import result',
  })
  await mutation.execute(undefined)
  let aborted = false
  let finish: ((value: string) => void) | undefined
  const pending = client
    .fetchQuery({
      queryKey: ['films'],
      queryFn: ({ signal }) =>
        new Promise<string>((resolve) => {
          finish = resolve
          signal.addEventListener('abort', () => {
            aborted = true
          })
        }),
    })
    .catch(() => undefined)
  const destinations: string[] = []
  await clearSessionData(client, (path) => {
    assert.equal(aborted, true)
    assert.equal(client.getQueryCache().getAll().length, 0)
    assert.equal(client.getMutationCache().getAll().length, 0)
    destinations.push(path)
  })
  assert.deepEqual(destinations, ['/login'])
  assert.ok(finish)
  finish('late private response')
  await pending
  assert.equal(client.getQueryData(['films']), undefined)
  assert.equal(client.getQueryData(['albums']), undefined)
})

test('logout still clears data and navigates if cancellation rejects', async () => {
  class FailingCancellationClient extends QueryClient {
    override async cancelQueries(): Promise<void> {
      throw new Error('cancellation failed')
    }
  }
  const client = new FailingCancellationClient()
  client.setQueryData(['albums'], ['private album'])
  const destinations: string[] = []
  await assert.rejects(
    clearSessionData(client, (path) => destinations.push(path)),
  )
  assert.deepEqual(destinations, ['/login'])
  assert.equal(client.getQueryCache().getAll().length, 0)
})
