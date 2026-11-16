const BROWSER_KEY = 'player:client'
const DRIVING_KEY = 'player:driving'
const BROWSER_ID = /^[A-Za-z0-9_-]{8,64}$/
/** A reload is over well within this. */
const RELOAD_WITHIN_MS = 15_000

/**
 * Names this tab as a place music plays. It is kept for the tab, so a reload
 * is the same browser and two tabs are different ones.
 */
export function playerBrowserId(): string {
  try {
    const saved = window.sessionStorage.getItem(BROWSER_KEY)
    if (saved && BROWSER_ID.test(saved)) return saved
    const created = crypto.randomUUID()
    window.sessionStorage.setItem(BROWSER_KEY, created)
    return created
  } catch {
    // Without tab storage a reload counts as another browser.
    return crypto.randomUUID()
  }
}

/**
 * Names one load of the page among the account's open clients. A duplicated
 * tab starts with a copy of the first tab's storage, so this is never stored.
 */
export function playerClientId(): string {
  return crypto.randomUUID()
}

/** Notes, as the page closes, that it was running the queue. */
export function markDriving(now: number) {
  try {
    window.sessionStorage.setItem(DRIVING_KEY, String(now))
  } catch {
    /* The reloaded page then waits for the lease like any other. */
  }
}

/** Whether this tab was running the queue when it was reloaded just now. */
export function takeDriving(now: number): boolean {
  try {
    const marked = Number(window.sessionStorage.getItem(DRIVING_KEY))
    window.sessionStorage.removeItem(DRIVING_KEY)
    return marked > 0 && now - marked >= 0 && now - marked <= RELOAD_WITHIN_MS
  } catch {
    return false
  }
}

const BROWSERS: Array<[RegExp, string]> = [
  [/Edg(?:e|A|iOS)?\//, 'Edge'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
]
const PLATFORMS: Array<[RegExp, string]> = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Macintosh|Mac OS X/, 'Mac'],
  [/Windows/, 'Windows'],
  [/Linux|X11/, 'Linux'],
]

/** A short name for a browser, such as "Safari on iPhone", from its user agent. */
export function playerClientName(userAgent: string): string {
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1]
  const platform = PLATFORMS.find(([pattern]) => pattern.test(userAgent))?.[1]
  if (browser && platform) return `${browser} on ${platform}`
  return browser ?? platform ?? 'Another browser'
}
