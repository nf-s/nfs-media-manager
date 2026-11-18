import { ArtistProfileProviderSchema } from '@repo/schemas/artist-profiles'
import type { ProviderSummary } from '@repo/schemas/provider'

const builtinLabels = {
  spotify: 'Spotify',
  musicbrainz: 'MusicBrainz',
  discogs: 'Discogs',
  lastfm: 'Last.fm',
}

/** Older catalog responses omit the capability for the built-in providers. */
export function supportsArtistEnrichment(provider: ProviderSummary) {
  return (
    provider.supportsArtistEnrichment ??
    ArtistProfileProviderSchema.safeParse(provider.id).success
  )
}

export function artistProviderLabel(
  provider: string,
  catalog: readonly ProviderSummary[] | undefined,
) {
  const configured = catalog?.find(({ id }) => id === provider)
  if (configured) return configured.displayName
  const builtin = ArtistProfileProviderSchema.safeParse(provider)
  return builtin.success ? builtinLabels[builtin.data] : provider
}
