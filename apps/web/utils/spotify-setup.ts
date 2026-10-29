export function spotifyCallbackSetup(
  apiBaseUrl: string,
  appUrl: string,
  redirectUri: string | null,
) {
  try {
    const api = new URL(apiBaseUrl || appUrl)
    const web = new URL(appUrl)
    const callback = redirectUri
      ? new URL(redirectUri)
      : new URL('/api/v1/spotify/callback', api)
    if (callback.hostname === 'localhost') callback.hostname = '127.0.0.1'
    const loopback =
      callback.hostname === '127.0.0.1' || callback.hostname === '[::1]'
    if (
      callback.protocol !== 'https:' &&
      !(callback.protocol === 'http:' && loopback)
    )
      return null
    if (callback.username || callback.password || web.username || web.password)
      return null
    return {
      callbackUrl: callback.href,
    }
  } catch {
    return null
  }
}
