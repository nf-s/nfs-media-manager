import { SONOS_PLAYBACK_CLIENT_HEADER } from '@repo/schemas/playback'
import {
  SONOS_REASON_HEADER,
  SonosCommandResultSchema,
  SonosCommandSchema,
  SonosContentInputSchema,
  SonosContentResultSchema,
  SonosGroupStateSchema,
  SonosPlaybackMatchSchema,
  SonosPlaybackQuerySchema,
  SonosRoomsSchema,
  type SonosCommand,
  type SonosContentInput,
  type SonosGroupControl,
  type SonosGroupState,
  type SonosStateReason,
} from '@repo/schemas/sonos'
import { fetchApiData } from './api'

/**
 * Plays Spotify content on Sonos groups and controls them through the
 * server's Sonos connection; Spotify accepts no app commands for these
 * speakers.
 */
export type SonosControlApi = {
  /** The group playing this track under the device name Spotify reports. */
  find(trackUri: string, device: string): Promise<SonosGroupControl | null>
  command(groupId: string, command: SonosCommand): Promise<void>
  /** What the group plays now; the volume is read only when asked for. */
  state(
    groupId: string,
    volume: boolean,
    reason?: SonosStateReason,
  ): Promise<SonosGroupState>
  /** Loads Spotify tracks or albums into the group's own queue. */
  load(groupId: string, input: SonosContentInput): Promise<void>
}

export function createSonosControlApi(apiBaseUrl: string, clientId: string) {
  const headers = { [SONOS_PLAYBACK_CLIENT_HEADER]: clientId }
  const api: SonosControlApi = {
    async find(trackUri, device) {
      const query = SonosPlaybackQuerySchema.safeParse({ trackUri, device })
      if (!query.success) return null
      const search = new URLSearchParams(query.data).toString()
      const result = await fetchApiData(
        apiBaseUrl,
        `/api/v1/sonos/playback?${search}`,
        SonosPlaybackMatchSchema,
        { headers },
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
          headers,
          body: JSON.stringify(SonosCommandSchema.parse(command)),
        },
      )
    },
    state(groupId, volume, reason) {
      return fetchApiData(
        apiBaseUrl,
        `/api/v1/sonos/groups/${encodeURIComponent(groupId)}/state${volume ? '?volume=true' : ''}`,
        SonosGroupStateSchema,
        {
          headers: reason
            ? { ...headers, [SONOS_REASON_HEADER]: reason }
            : headers,
        },
      )
    },
    async load(groupId, input) {
      await fetchApiData(
        apiBaseUrl,
        `/api/v1/sonos/groups/${encodeURIComponent(groupId)}/content`,
        SonosContentResultSchema,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(SonosContentInputSchema.parse(input)),
        },
      )
    },
  }
  return {
    ...api,
    rooms: () =>
      fetchApiData(apiBaseUrl, '/api/v1/sonos/rooms', SonosRoomsSchema, {
        headers,
      }),
  }
}
