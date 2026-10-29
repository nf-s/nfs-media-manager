import {
  PluginResultSchema,
  type JsonValue,
  type PluginNormalizedResult,
} from '@repo/media-plugin-sdk'
import { removeSpotifyAudioFeatures } from '@repo/schemas/audio-features'

export function sanitizeAlbumProviderResult(
  payload: JsonValue,
  normalized: PluginNormalizedResult,
) {
  return PluginResultSchema.parse(
    removeSpotifyAudioFeatures(
      JSON.parse(JSON.stringify({ payload, normalized })),
    ).value,
  )
}
