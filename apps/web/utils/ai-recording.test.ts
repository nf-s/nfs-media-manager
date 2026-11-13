import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  captureRecording,
  chooseRecordingMimeType,
  encodeRecording,
  microphoneErrorMessage,
  type AudioCaptureDriver,
} from './ai-recording'

function fixture() {
  let events: Parameters<AudioCaptureDriver['start']>[0] | undefined
  let disposals = 0
  let stops = 0
  const audio: Blob[] = []
  const failures: string[] = []
  const driver: AudioCaptureDriver = {
    start: (next) => {
      events = next
    },
    stop: () => {
      stops += 1
    },
    dispose: () => {
      disposals += 1
    },
    mimeType: () => 'audio/webm',
  }
  return {
    driver,
    callbacks: {
      complete: (value: Blob) => audio.push(value),
      failed: (value: string) => failures.push(value),
    },
    emit: () => {
      assert.ok(events)
      return events
    },
    audio,
    failures,
    disposed: () => disposals,
    stopped: () => stops,
  }
}

test('stopping keeps the final recorder chunk and releases the device once', async () => {
  const f = fixture()
  const session = captureRecording(f.driver, f.callbacks)
  f.emit().data(new Blob(['first']))
  session.stop()
  session.stop()
  f.emit().data(new Blob(['last']))
  f.emit().stopped()
  assert.equal(f.stopped(), 1)
  assert.equal(f.disposed(), 1)
  assert.equal(f.audio.length, 1)
  assert.equal(await f.audio[0]?.text(), 'firstlast')
  assert.equal(f.audio[0]?.type, 'audio/webm')
  session.cancel()
  assert.equal(f.disposed(), 1)
})

test('cancel discards audio and ignores late recording events', () => {
  const f = fixture()
  const session = captureRecording(f.driver, f.callbacks)
  f.emit().data(new Blob(['audio']))
  session.cancel()
  f.emit().data(new Blob(['late']))
  f.emit().stopped()
  f.emit().failed()
  assert.deepEqual(f.audio, [])
  assert.deepEqual(f.failures, [])
  assert.equal(f.disposed(), 1)
})

test('size limits stop capture and never submit a partial recording', () => {
  const f = fixture()
  captureRecording(f.driver, f.callbacks, { bytes: 5, milliseconds: 1000 })
  f.emit().data(new Blob(['12345']))
  f.emit().data(new Blob(['6']))
  f.emit().stopped()
  assert.equal(f.audio.length, 0)
  assert.match(f.failures[0] ?? '', /too large/)
  assert.equal(f.disposed(), 1)
})

test('duration limit stops the recorder and empty audio produces an actionable error', async () => {
  const f = fixture()
  captureRecording(f.driver, f.callbacks, { bytes: 10, milliseconds: 5 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(f.stopped(), 1)
  f.emit().stopped()
  assert.match(f.failures[0] ?? '', /No audio/)
  assert.equal(f.disposed(), 1)
})

test('recording start errors dispose resources', () => {
  const f = fixture()
  f.driver.start = () => {
    throw new Error('synthetic recorder failure')
  }
  captureRecording(f.driver, f.callbacks)
  assert.equal(f.disposed(), 1)
  assert.match(f.failures[0] ?? '', /Could not start/)
})

test('encoding preserves binary audio and MIME selection falls back for Safari', async () => {
  assert.equal(
    await encodeRecording(new Blob([new Uint8Array([0, 127, 128, 255])])),
    'AH+A/w==',
  )
  assert.equal(
    chooseRecordingMimeType((type) => type === 'audio/mp4'),
    'audio/mp4',
  )
  assert.equal(
    chooseRecordingMimeType(() => false),
    undefined,
  )
  await assert.rejects(encodeRecording(new Blob([])), /No audio/)
})

test('microphone errors do not expose raw device errors', () => {
  const error = new Error('synthetic device detail')
  error.name = 'NotAllowedError'
  assert.match(microphoneErrorMessage(error), /denied/)
  assert.doesNotMatch(microphoneErrorMessage(error), /synthetic/)
})
