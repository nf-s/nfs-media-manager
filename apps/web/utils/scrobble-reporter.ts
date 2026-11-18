import {
  LASTFM_SCROBBLE_BATCH,
  LastfmAuthorizeInputSchema,
  LastfmAuthorizeResultSchema,
  LastfmPlaySchema,
  LastfmScrobbleInputSchema,
  LastfmScrobbleResultSchema,
  type LastfmPlay,
  type LastfmScrobbleResult,
} from '@repo/schemas/lastfm'
import { fetchApiData } from './api'

export type ScrobbleReporterOptions = {
  send: (plays: LastfmPlay[]) => Promise<LastfmScrobbleResult>
  /** The server has no Last.fm sign-in any more. */
  onDisconnected?: () => void
  retryMs?: number
}

/** A report the server could not be reached for is sent again this much later. */
const RETRY_MS = 30_000
/** Plays kept while the server cannot be reached; the oldest go first. */
const KEPT_PLAYS = 200

/** Asks the server for a Last.fm sign-in URL and checks that it leads to Last.fm. */
export async function lastfmAuthorizationUrl(
  apiBaseUrl: string,
): Promise<string> {
  const result = await fetchApiData(
    apiBaseUrl,
    '/api/v1/lastfm/scrobbling/authorize',
    LastfmAuthorizeResultSchema,
    {
      method: 'POST',
      body: JSON.stringify(LastfmAuthorizeInputSchema.parse({})),
    },
  )
  const url = new URL(result.url)
  if (url.protocol !== 'https:' || url.hostname !== 'www.last.fm')
    throw new Error('The authorization URL was not a Last.fm URL.')
  return url.href
}

export function sendScrobbles(apiBaseUrl: string) {
  return (plays: LastfmPlay[]) =>
    fetchApiData(
      apiBaseUrl,
      '/api/v1/lastfm/scrobbles',
      LastfmScrobbleResultSchema,
      {
        method: 'POST',
        body: JSON.stringify(LastfmScrobbleInputSchema.parse({ plays })),
      },
    )
}

/**
 * Passes played tracks to the server, which scrobbles them. The server keeps
 * a play until Last.fm has taken it, so this only holds on to plays while
 * the server itself cannot be reached.
 */
export function createScrobbleReporter(options: ScrobbleReporterOptions) {
  const retryMs = options.retryMs ?? RETRY_MS
  let kept: LastfmPlay[] = []
  let sending = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  async function flush() {
    if (sending || disposed || kept.length === 0) return
    sending = true
    const batch = kept.slice(0, LASTFM_SCROBBLE_BATCH)
    let sent = false
    try {
      const result = await options.send(batch)
      sent = true
      if (!result.connected) {
        // Nothing can be scrobbled until Last.fm is connected again.
        kept = []
        options.onDisconnected?.()
      }
    } catch {
      // The plays stay kept and go with the next report.
    }
    sending = false
    if (disposed) return
    if (sent) {
      kept = kept.filter((play) => !batch.includes(play))
      void flush()
    } else if (!timer)
      timer = setTimeout(() => {
        timer = null
        void flush()
      }, retryMs)
  }

  return {
    report(plays: readonly LastfmPlay[]) {
      if (disposed) return
      const valid = plays.flatMap((play) => {
        const parsed = LastfmPlaySchema.safeParse(play)
        return parsed.success ? [parsed.data] : []
      })
      if (valid.length === 0) return
      kept = [...kept, ...valid].slice(-KEPT_PLAYS)
      void flush()
    },
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

export type ScrobbleReporter = ReturnType<typeof createScrobbleReporter>
