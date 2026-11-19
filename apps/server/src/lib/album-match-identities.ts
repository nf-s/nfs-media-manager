import type { PluginReference } from '@repo/media-plugin-sdk'
import { AlbumHttpUrlSchema } from '@repo/schemas/provider-identification'
import { spotifyAlbumId } from '@/lib/spotify-api'

type AlbumMatchIdentity = Pick<PluginReference, 'referenceType' | 'externalId'>

export type RejectedAlbumIdentity = {
  provider: string
  sourceProvider: string
  referenceType: string
  identifier: string
  aliases: readonly AlbumMatchIdentity[]
}

function trackingParameter(name: string) {
  return /^(?:utm_.+|fbclid|gclid|mc_cid|mc_eid)$/i.test(name)
}

export function albumMatchUrlHasIdentityQuery(url: URL) {
  return [...url.searchParams.keys()].some((name) => !trackingParameter(name))
}

function albumMatchUrl(value: string): string | null {
  if (
    !/^https?:\/\//i.test(value) ||
    !AlbumHttpUrlSchema.safeParse(value).success
  )
    return null
  const url = new URL(value)
  const host = url.hostname.replace(/^www\./, '')
  let path = url.pathname.replace(/\/$/, '')
  if (url.port === '' && host === 'rateyourmusic.com') {
    path = path.replace(
      /^(\/release\/[^/]+\/[^/]+\/[^/]+)\/(?:reviews|lists)(?:\/\d+)?$/,
      '$1',
    )
    path = path.replace(/^(\/release\/[^/]+\/[^/]+\/[^/]+)\.p$/, '$1')
    return host + path
  }
  if (url.port === '' && host === 'last.fm') {
    path = path.replace(/^\/music\/\+noredirect\//, '/music/')
    return host + path.replaceAll('%20', '+')
  }
  if (url.port === '' && host === 'metacritic.com') {
    path = path.replace(
      /^(\/music\/[^/]+(?:\/[^/]+)?)\/(?:critic-reviews|user-reviews)$/,
      '$1',
    )
    return host + path
  }
  if (
    url.port === '' &&
    ['discogs.com', 'musicbrainz.org', 'open.spotify.com'].includes(host)
  )
    return host + path
  for (const name of [...url.searchParams.keys()])
    if (trackingParameter(name)) url.searchParams.delete(name)
  return url.origin + url.pathname + url.search + url.hash
}

function referenceKey(provider: string, identity: AlbumMatchIdentity) {
  const { referenceType, externalId } = identity
  if (provider === 'spotify' && ['spotify', 'album'].includes(referenceType)) {
    const id = spotifyAlbumId(externalId)
    if (id) return `album:${id}`
  }
  if (
    (provider === 'musicbrainz' && referenceType === 'release-group') ||
    (provider === 'lastfm' && referenceType === 'mbid')
  )
    return `${referenceType}:${externalId.toLowerCase()}`
  return `${referenceType}:${externalId}`
}

/** Provider IDs use their own namespace. A source URL can match across providers. */
export function createAlbumMatchRejectionPredicate(
  provider: string,
  rejections: readonly RejectedAlbumIdentity[],
) {
  const references = new Set<string>()
  const urls = new Set<string>()
  for (const rejection of rejections) {
    const identities = [
      {
        referenceType: rejection.referenceType,
        externalId: rejection.identifier,
      },
      ...rejection.aliases,
    ]
    for (const identity of identities) {
      const url = albumMatchUrl(identity.externalId)
      if (url) urls.add(url)
      if (
        rejection.provider === provider ||
        rejection.sourceProvider === provider
      )
        references.add(referenceKey(provider, identity))
    }
  }
  return (identity: AlbumMatchIdentity) => {
    if (references.size && references.has(referenceKey(provider, identity)))
      return true
    const url = urls.size ? albumMatchUrl(identity.externalId) : null
    return url !== null && urls.has(url)
  }
}
