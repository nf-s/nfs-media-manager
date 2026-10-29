import { z } from 'zod'

/** Convert stored video links to one HTTPS destination, never executable URLs. */
export function youtubeTrailerUrl(value: unknown): string | undefined {
  const parsed = z.string().url().safeParse(value)
  if (!parsed.success) return undefined
  const url = new URL(parsed.data)
  if (url.username || url.password || url.port) return undefined
  let videoId: string | null | undefined
  if (
    url.protocol === 'plugin:' &&
    url.hostname === 'plugin.video.youtube' &&
    url.pathname === '/' &&
    url.searchParams.get('action') === 'play_video'
  ) {
    videoId = url.searchParams.get('videoid')
  } else if (url.protocol === 'https:' || url.protocol === 'http:') {
    if (url.hostname === 'youtu.be') {
      videoId = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1]
    } else if (
      ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)
    ) {
      videoId =
        url.pathname === '/watch'
          ? url.searchParams.get('v')
          : /^\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})\/?$/.exec(
              url.pathname,
            )?.[1]
    } else if (
      ['youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(
        url.hostname,
      )
    ) {
      videoId = /^\/embed\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1]
    }
  }
  return videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId)
    ? `https://www.youtube.com/watch?v=${videoId}`
    : undefined
}
