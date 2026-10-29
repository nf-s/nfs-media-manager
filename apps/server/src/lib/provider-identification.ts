import { AlbumRymUrlSchema } from '@/plugins/builtin/album-provider-helpers'

type LookupProvider = {
  id: string
  identifierTypes?: string[]
  supportsNameLookup?: boolean
}

export function hasProviderIdentifier(
  provider: LookupProvider,
  mediaType: 'album' | 'film',
  references: Array<{
    provider: string
    referenceType: string
    externalId: string
  }>,
): boolean {
  const types = provider.identifierTypes ?? []
  if (!types.length) return true
  return references.some((reference) => {
    if (!types.includes(reference.referenceType)) return false
    if (
      mediaType === 'album' &&
      provider.id === 'serply' &&
      reference.referenceType === 'rym-url'
    )
      return AlbumRymUrlSchema.safeParse(reference.externalId).success
    if (
      mediaType === 'album' &&
      provider.id === 'spotify' &&
      reference.referenceType === 'spotify'
    )
      return /^[A-Za-z0-9]{22}$/.test(reference.externalId)
    if (
      mediaType === 'album' &&
      ['upc', 'ean'].includes(reference.referenceType)
    )
      return /^\d{8,14}$/.test(reference.externalId)
    if (mediaType === 'album' && reference.provider !== provider.id)
      return false
    if (reference.referenceType === 'imdb')
      return /^tt\d+$/.test(reference.externalId)
    if (reference.referenceType === 'tmdb')
      return /^\d+$/.test(reference.externalId)
    return reference.externalId.trim().length > 0
  })
}

export function canIdentifyMedia(
  provider: LookupProvider,
  item: {
    mediaType: 'album' | 'film'
    title: string
    artists: string[]
    providerReferences: Array<{
      provider: string
      referenceType: string
      externalId: string
    }>
  },
): boolean {
  return (
    hasProviderIdentifier(provider, item.mediaType, item.providerReferences) ||
    (item.mediaType === 'album' &&
      provider.supportsNameLookup === true &&
      item.title.trim().length > 0 &&
      item.artists.some((artist) => artist.trim().length > 0))
  )
}
