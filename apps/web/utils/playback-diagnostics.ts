import type { PlaybackDiagnosticInput } from '@repo/schemas/playback-diagnostics'

export type PlaybackEvent = Omit<
  PlaybackDiagnosticInput,
  'eventId' | 'at' | 'browser'
>
export type PlaybackTrace = (
  stage: PlaybackEvent['stage'],
  details?: Partial<Omit<PlaybackEvent, 'attemptId' | 'stage'>>,
) => void

export function createPlaybackDiagnostics(
  apiBaseUrl: string,
  userAgent: string,
  send: typeof fetch = fetch,
) {
  const browser = /Android/i.test(userAgent)
    ? 'android'
    : /iPhone|iPad|iPod/i.test(userAgent)
      ? 'ios'
      : /Windows|Macintosh|Linux/i.test(userAgent)
        ? 'desktop'
        : 'other'
  let pending: PlaybackDiagnosticInput[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let sending: PlaybackDiagnosticInput[] | null = null
  let disposed = false

  function schedule(delay: number) {
    if (disposed || timer || sending || !pending.length) return
    timer = setTimeout(() => {
      timer = undefined
      void flush()
    }, delay)
  }

  async function post(events: PlaybackDiagnosticInput[]) {
    try {
      const response = await send(`${apiBaseUrl}/api/v1/playback/diagnostics`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
        keepalive: true,
      })
      if (response.ok || [400, 401, 403, 413, 422].includes(response.status)) {
        pending = pending.filter((event) => !events.includes(event))
        return true
      }
    } catch {
      // Keep the batch for the next attempt while the page is open.
    }
    return false
  }

  async function flush() {
    if (sending || !pending.length) return
    sending = pending.slice(0, 32)
    const acknowledged = await post(sending)
    sending = null
    schedule(acknowledged ? 0 : 5_000)
  }

  function flushOnExit() {
    // A phone can suspend the page before the in-flight batch gets a reply.
    // Hand the newest remaining events to a separate keepalive request now.
    const tail = pending.filter((event) => !sending?.includes(event)).slice(-32)
    if (tail.length) void post(tail)
  }

  return {
    record(event: PlaybackEvent) {
      if (disposed) return
      pending.push({
        ...event,
        eventId: crypto.randomUUID(),
        browser,
        at: Date.now(),
      })
      if (pending.length > 256) pending.shift()
      schedule(100)
    },
    flushOnExit,
    dispose() {
      clearTimeout(timer)
      disposed = true
      flushOnExit()
    },
  }
}
