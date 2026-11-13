import {
  AI_AUDIO_MAX_BYTES,
  AI_AUDIO_MAX_SECONDS,
} from '@repo/schemas/ai-search'

export const recordingMimeTypes = [
  'audio/webm;codecs=opus',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/webm',
]

export function chooseRecordingMimeType(
  supported: (mimeType: string) => boolean,
) {
  return recordingMimeTypes.find(supported)
}

export async function encodeRecording(blob: Blob): Promise<string> {
  if (!blob.size) throw new Error('No audio was recorded. Try again.')
  if (blob.size > AI_AUDIO_MAX_BYTES)
    throw new Error('The recording is too large. Record a shorter request.')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(binary)
}

export type AudioCaptureDriver = {
  start: (events: {
    data: (chunk: Blob) => void
    stopped: () => void
    failed: () => void
  }) => void
  stop: () => void
  dispose: () => void
  mimeType: () => string
}

/** Owns a recording until it finishes or is discarded, including device cleanup. */
export function captureRecording(
  driver: AudioCaptureDriver,
  callbacks: {
    complete: (audio: Blob) => void
    failed: (message: string) => void
  },
  limits = {
    bytes: AI_AUDIO_MAX_BYTES,
    milliseconds: AI_AUDIO_MAX_SECONDS * 1000,
  },
) {
  const chunks: Blob[] = []
  let size = 0
  let ended = false
  let stopping = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function dispose() {
    clearTimeout(timer)
    driver.dispose()
    chunks.length = 0
  }

  function fail(message: string) {
    if (ended) return
    ended = true
    try {
      driver.stop()
    } catch {
      // The recording is already being discarded; cleanup still owns the device.
    } finally {
      dispose()
      callbacks.failed(message)
    }
  }

  function stop() {
    if (ended || stopping) return
    stopping = true
    clearTimeout(timer)
    try {
      driver.stop()
    } catch {
      fail('Could not finish the recording. Try again.')
    }
  }

  timer = setTimeout(stop, limits.milliseconds)
  try {
    driver.start({
      data: (chunk) => {
        if (ended || !chunk.size) return
        size += chunk.size
        if (size > limits.bytes) {
          fail('The recording is too large. Record a shorter request.')
          return
        }
        chunks.push(chunk)
      },
      stopped: () => {
        if (ended) return
        if (!size) {
          fail('No audio was recorded. Try again.')
          return
        }
        ended = true
        const audio = new Blob(chunks, { type: driver.mimeType() })
        dispose()
        callbacks.complete(audio)
      },
      failed: () => fail('The microphone stopped recording. Try again.'),
    })
  } catch {
    fail('Could not start recording. Check your microphone and try again.')
  }

  return {
    stop,
    cancel: () => {
      if (ended) return
      ended = true
      try {
        driver.stop()
      } catch {
        // A failed recorder must not prevent cancellation from releasing the device.
      } finally {
        dispose()
      }
    },
  }
}

export function microphoneErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError')
      return 'Microphone access was denied. Allow it in your browser settings or type your request.'
    if (error.name === 'NotFoundError')
      return 'No microphone is available. Connect one or type your request.'
    if (error.name === 'NotReadableError')
      return 'The microphone is unavailable. Check whether another app is using it.'
  }
  return 'Could not access the microphone. Check your browser settings or type your request.'
}
