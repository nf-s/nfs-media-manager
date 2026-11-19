import {
  PluginArtistResultSchema,
  PluginDiagnosticSchema,
  isProviderArtistSearchAmbiguousError,
  isProviderItemNotFoundError,
  PluginResultSchema,
  type MediaPluginArtistContext,
  type MediaPluginScrapeContext,
  type MediaPluginTestContext,
} from '@repo/media-plugin-sdk'
import { ArtistProfileProviderSchema } from '@repo/schemas/artist-profiles'
import type { ProviderResponseCapture } from '@repo/schemas/provider-response'
import {
  providerResponseSecretValues,
  createProviderResponseReplay,
} from '@/lib/provider-response-history'
import { lookupArtistProvider } from '@/plugins/builtin/artist-providers'
import { getScrapePlugin } from '@/plugins/registry'

type ArtistRecordingContext = Pick<
  Parameters<typeof lookupArtistProvider>[3],
  'spotifyRecordings' | 'loadLastfmRecordings'
>

type ReplayInput =
  | { phase: 'media'; context: Omit<MediaPluginScrapeContext, 'request'> }
  | {
      phase: 'artist'
      context: Omit<MediaPluginArtistContext, 'request'>
      bootstrap?: boolean
      recordings?: ArtistRecordingContext
    }

/**
 * Run the current adapter with reconstructed inputs and SDK requests backed only
 * by saved evidence. The caller supplies lookup inputs from the intended attempt
 * and provides a separate projector for worker-native responses, when available.
 * Arbitrary installed adapter code must run in a network-disabled process.
 */
export async function replayScrapeProvider(
  provider: string,
  captures: readonly ProviderResponseCapture[],
  inputs: readonly ReplayInput[],
  options: {
    projectNativeResponse?: (
      archive: ProviderResponseCapture,
      input: Parameters<MediaPluginTestContext['request']>[0],
    ) => Promise<Response>
  } = {},
) {
  const plugin = await getScrapePlugin(provider)
  if (!plugin) throw new Error('Scrape provider is no longer installed')
  const builtin = ArtistProfileProviderSchema.safeParse(provider)
  const secrets = inputs.flatMap(({ context }) =>
    providerResponseSecretValues(context.secrets),
  )
  const replay = createProviderResponseReplay(captures, { ...options, secrets })
  try {
    const results = []
    for (const input of inputs) {
      const request = replay.requestFor(input.phase)
      if (input.phase === 'media') {
        if (!plugin.scrapeMediaItem)
          throw new Error('Provider has no media scraper')
        results.push(
          PluginResultSchema.parse(
            await plugin.scrapeMediaItem({
              ...input.context,
              request,
            }),
          ),
        )
      } else if (builtin.success && !input.bootstrap) {
        results.push(
          await lookupArtistProvider(
            builtin.data,
            input.context.artist.name,
            input.context.providerArtistId,
            {
              ...input.context,
              ...input.recordings,
              request,
              recordDiagnostic(value) {
                const diagnostic = PluginDiagnosticSchema.safeParse(value)
                if (diagnostic.success)
                  input.context.recordDiagnostic?.(diagnostic.data)
              },
              searched: async () => undefined,
            },
          ),
        )
      } else {
        if (!plugin.scrapeArtist)
          throw new Error('Provider has no artist scraper')
        try {
          results.push(
            PluginArtistResultSchema.parse(
              await plugin.scrapeArtist({ ...input.context, request }),
            ),
          )
        } catch (error) {
          if (
            !input.bootstrap ||
            (!isProviderArtistSearchAmbiguousError(error) &&
              !isProviderItemNotFoundError(error))
          )
            throw error
        }
      }
    }
    return results
  } finally {
    replay.assertComplete()
  }
}
