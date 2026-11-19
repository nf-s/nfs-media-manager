import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { openLocalResponseArchive } from './local-response-archive'

test('opens the verified native worker file locally and rejects a mismatched or damaged archive', async () => {
  const text = '{"name":"Étoile","futureField":7}'
  const retainedBytes = Buffer.byteLength(text)
  const receipt = {
    state: 'local',
    reference: 'fixture-archive',
    retainedBytes,
  } satisfies Parameters<typeof openLocalResponseArchive>[1]
  const record = {
    version: 1,
    id: receipt.reference,
    retainedBytes,
    text,
    sha256: createHash('sha256').update(text).digest('hex'),
    redacted: true,
  }
  const file = (change: Partial<typeof record> = {}) =>
    new Blob([JSON.stringify({ ...record, ...change })])
  assert.deepEqual(await openLocalResponseArchive(file(), receipt), {
    state: 'captured',
    text,
    redacted: true,
  })
  for (const change of [
    { id: 'other' },
    { sha256: '0'.repeat(64) },
    { retainedBytes: 0 },
    { text: 'other' },
  ])
    await assert.rejects(openLocalResponseArchive(file(change), receipt))
})
