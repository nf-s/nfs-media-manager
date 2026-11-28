/**
 * What `fetchApiData` asks of the device store (DEVICE-40). Nothing is
 * installed while the setting is off, and `fetchApiData` then runs exactly
 * as it does without a store.
 */
export interface DeviceSeam {
  /**
   * The data of a `GET` the copy answers, as the API envelope's `data`;
   * `undefined` when the API must answer. Rejects only with the signal's
   * reason when it aborts, as `fetch` does.
   */
  read(path: string, signal?: AbortSignal | null): Promise<DeviceAnswer>
  /** A write is starting; reads go to the API until the copy has caught up after `settle`. */
  beginWrite(path: string): () => void
  /** The API answered 401: the session has ended (DEVICE-45). */
  unauthorized(): void
}

export type DeviceAnswer = { data: unknown } | undefined

let installed: DeviceSeam | undefined

export function deviceSeam(): DeviceSeam | undefined {
  return installed
}

export function installDeviceSeam(seam: DeviceSeam | undefined) {
  installed = seam
}

/**
 * Requests that send a body but change no library row: player state, Sonos
 * commands, AI search and ratings reports. Every other non-`GET` request
 * holds reads on the API until the copy has caught up, so a player's
 * heartbeat does not keep the copy behind. A prefix belongs here only if
 * no request under it changes a row the feed publishes.
 */
const nonLibraryWrites = [
  '/api/v1/playback/session',
  '/api/v1/sonos/',
  '/api/v1/ai/',
  '/api/v1/ratings/',
]

export function changesLibraryRows(path: string): boolean {
  return !nonLibraryWrites.some((prefix) => path.startsWith(prefix))
}
