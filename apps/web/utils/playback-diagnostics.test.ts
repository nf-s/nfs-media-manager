import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PlaybackDiagnosticInputSchema } from '@repo/schemas/playback-diagnostics'
import { z } from 'zod'
import { createPlaybackDiagnostics } from './playback-diagnostics'

test('a closing phone sends the latest tap while an earlier batch is still in flight', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const batches: string[][] = []
  let finish: (() => void) | undefined
  const diagnostics = createPlaybackDiagnostics(
    '',
    'Android',
    async (_url, init) => {
      assert.equal(init?.keepalive, true)
      assert.equal(typeof init.body, 'string')
      const { events } = z
        .object({ events: z.array(PlaybackDiagnosticInputSchema) })
        .parse(JSON.parse(String(init.body)))
      assert.ok(
        events.every((event) => event.browser === 'android' && event.eventId),
      )
      batches.push(events.map((event) => event.stage))
      if (batches.length === 1)
        await new Promise<void>((resolve) => {
          finish = resolve
        })
      return new Response(null, { status: 204 })
    },
  )
  const attemptId = crypto.randomUUID()
  diagnostics.record({ stage: 'requested', action: 'play', attemptId })
  t.mock.timers.tick(100)
  diagnostics.record({ stage: 'failed', reason: 'no-device', attemptId })
  diagnostics.dispose()
  assert.deepEqual(batches, [['requested'], ['failed']])
  assert.ok(finish)
  finish()
})
