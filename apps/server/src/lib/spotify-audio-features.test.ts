import { describe, expect, it } from 'vitest'
import { PluginResultSchema } from '@repo/media-plugin-sdk'
import { sanitizeAlbumProviderResult } from './spotify-audio-features'

describe('album persistence boundary', () => {
  it('scrubs raw and normalized data from every provider before persistence', () => {
    const input = PluginResultSchema.parse({
      payload: { spotify: { audioFeatures: [{ energy: 0.2 }], popularity: 0 } },
      normalized: {
        mediaPatch: {
          metadata: { browse: { energy: 1, mode: 0, scrobbles: 0 } },
        },
        albumPatch: { metadata: { tempo: 110 }, durationSec: 23 },
        tracks: [{ title: 'Track', position: 1, durationSec: 23 }],
      },
    })
    const result = sanitizeAlbumProviderResult(input.payload, input.normalized)
    expect(result.payload).toEqual({ spotify: { popularity: 0 } })
    expect(result.normalized.mediaPatch?.metadata).toEqual({
      browse: { scrobbles: 0 },
    })
    expect(result.normalized.albumPatch).toEqual({
      metadata: {},
      durationSec: 23,
    })
    expect(result.normalized.tracks).toEqual(input.normalized.tracks)
    expect(input.normalized.mediaPatch?.metadata?.browse).toHaveProperty(
      'energy',
    )
  })
})
