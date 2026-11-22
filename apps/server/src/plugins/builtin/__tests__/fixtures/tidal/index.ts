export const tidalAlbumId = '900000001'
export const tidalUpc = '012345678901'
export const tidalTokenFixture = {
  access_token: 'fake-tidal-token',
  expires_in: 14400,
  scope: '',
  token_type: 'Bearer',
}

export type TidalFixtureTrackOptions = {
  version?: string
  isrc?: string | null
  duration?: string
  bpm?: number | null
  key?: string | null
  keyScale?: string | null
}

export function tidalTrackFixture(
  id: string,
  title: string,
  options: TidalFixtureTrackOptions = {},
) {
  return {
    id,
    type: 'tracks' as const,
    attributes: {
      title,
      ...(options.version ? { version: options.version } : {}),
      isrc:
        options.isrc === undefined
          ? `XXTST${id.slice(-7).padStart(7, '0')}`
          : options.isrc,
      duration: options.duration ?? 'PT4M28S',
      explicit: false,
      popularity: 0.25,
      availability: ['STREAM'],
      externalLinks: [
        {
          href: `https://tidal.com/browse/track/${id}`,
          meta: { type: 'TIDAL_SHARING' },
        },
      ],
      ...(options.bpm !== undefined ? { bpm: options.bpm } : {}),
      ...(options.key !== undefined ? { key: options.key } : {}),
      ...(options.keyScale !== undefined ? { keyScale: options.keyScale } : {}),
    },
  }
}

export const tidalItem = (
  id: string,
  trackNumber: number,
  volumeNumber = 1,
) => ({ id, type: 'tracks', meta: { volumeNumber, trackNumber } })

export function tidalAlbumFixture(
  items: ReturnType<typeof tidalItem>[],
  options: {
    id?: string
    barcodeId?: string
    numberOfItems?: number
    nextCursor?: string
  } = {},
) {
  const id = options.id ?? tidalAlbumId
  return {
    id,
    type: 'albums' as const,
    attributes: {
      title: 'Example Album',
      barcodeId: options.barcodeId ?? tidalUpc,
      albumType: 'ALBUM',
      numberOfItems: options.numberOfItems ?? items.length,
      numberOfVolumes: 1,
      releaseDate: '2020-05-01',
      externalLinks: [
        {
          href: `https://tidal.com/browse/album/${id}`,
          meta: { type: 'TIDAL_SHARING' },
        },
      ],
    },
    relationships: {
      items: {
        data: items,
        links: options.nextCursor
          ? {
              self: `/albums/${id}/relationships/items?countryCode=AU`,
              next: `/albums/${id}/relationships/items?countryCode=AU&page%5Bcursor%5D=${options.nextCursor}`,
              meta: { nextCursor: options.nextCursor },
            }
          : { self: `/albums/${id}/relationships/items?countryCode=AU` },
      },
    },
  }
}

export function tidalAlbumsDocument(
  albums: ReturnType<typeof tidalAlbumFixture>[],
  included: ReturnType<typeof tidalTrackFixture>[] = [],
) {
  return {
    data: albums,
    links: { self: '/albums?countryCode=AU' },
    included,
  }
}

export const tidalMissDocument = {
  data: [],
  links: { self: '/albums?countryCode=AU' },
  included: [],
}

export function tidalItemsPage(
  items: ReturnType<typeof tidalItem>[],
  included: ReturnType<typeof tidalTrackFixture>[],
  nextCursor?: string,
) {
  return {
    data: items,
    included,
    links: nextCursor
      ? {
          self: '/albums/x/relationships/items',
          next: `/albums/x/relationships/items?countryCode=AU&page%5Bcursor%5D=${nextCursor}`,
          meta: { nextCursor },
        }
      : { self: '/albums/x/relationships/items' },
  }
}

/** Track IDs 800000001..n, numbered 1..n on volume 1. */
export function tidalTrackRange(count: number, volumeNumber = 1, start = 0) {
  const tracks = Array.from({ length: count }, (_, index) =>
    tidalTrackFixture(
      `${800000001 + start + index}`,
      `Track ${start + index + 1}`,
    ),
  )
  const items = tracks.map((track, index) =>
    tidalItem(track.id, index + 1, volumeNumber),
  )
  return { tracks, items }
}
