import {
  SonosCommandResultSchema,
  SonosCommandSchema,
  SonosPlaybackMatchSchema,
  SonosPlaybackQuerySchema,
  type SonosCommand,
  type SonosGroupControl,
} from '@repo/schemas/sonos'
import { fetchApiData } from './api'

/**
 * Controls Spotify playback on a Sonos group through the server's Sonos
 * connection, for speakers Spotify accepts no app commands for.
 */
export type SonosControlApi = {
  /** The group playing this track under the device name Spotify reports. */
  find(trackUri: string, device: string): Promise<SonosGroupControl | null>
  command(groupId: string, command: SonosCommand): Promise<void>
}

export function createSonosControlApi(apiBaseUrl: string): SonosControlApi {
  return {
    async find(trackUri, device) {
      const query = SonosPlaybackQuerySchema.safeParse({ trackUri, device })
      if (!query.success) return null
      const search = new URLSearchParams(query.data).toString()
      const result = await fetchApiData(
        apiBaseUrl,
        `/api/v1/sonos/playback?${search}`,
        SonosPlaybackMatchSchema,
      )
      return result.group
    },
    async command(groupId, command) {
      await fetchApiData(
        apiBaseUrl,
        `/api/v1/sonos/groups/${encodeURIComponent(groupId)}/command`,
        SonosCommandResultSchema,
        {
          method: 'POST',
          body: JSON.stringify(SonosCommandSchema.parse(command)),
        },
      )
    },
  }
}
