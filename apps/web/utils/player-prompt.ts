const KEY = 'player:prompt'
const listeners = new Set<() => void>()

/** Whether the prompt to connect Spotify playback was dismissed in this browser. */
export function playerPromptDismissed() {
  try {
    return window.localStorage.getItem(KEY) === 'dismissed'
  } catch {
    return false
  }
}

export function setPlayerPromptDismissed(dismissed: boolean) {
  try {
    if (dismissed) window.localStorage.setItem(KEY, 'dismissed')
    else window.localStorage.removeItem(KEY)
  } catch {
    /* The prompt simply returns on the next visit when storage is unavailable. */
  }
  for (const listener of listeners) listener()
}

export function subscribePlayerPrompt(listener: () => void) {
  listeners.add(listener)
  window.addEventListener('storage', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', listener)
  }
}
