import type { PluginTrack } from '@repo/media-plugin-sdk'
import type {
  SonovaultAlbumConfirmation,
  SonovaultAlbumReferenceType,
} from '@repo/schemas/sonovault-album'
import type { SonovaultRelease } from './sonovault-api'

type Edition = SonovaultRelease['editions'][number]

/** The album's own identifiers a release is confirmed by (SONO-19). */
export type SonovaultAlbumIdentity = {
  spotifyAlbumId: string | null
  upc: string | null
  musicbrainzReleaseGroups: readonly string[]
  /** Library track count, to pick one MusicBrainz edition of several. */
  trackCount: number
}

/** A barcode's digits without leading zeros, or null. */
export function normalizedBarcode(value: string | null | undefined) {
  const digits = value?.trim() ?? ''
  if (!/^\d{1,20}$/.test(digits)) return null
  return digits.replace(/^0+/, '') || null
}

const sameId = (left: string, right: string) =>
  left.trim().toLowerCase() === right.trim().toLowerCase()

/** The MusicBrainz edition whose length is closest to the library album's. */
function closestEdition(editions: readonly Edition[], trackCount: number) {
  return (
    [...editions].sort(
      (left, right) =>
        Math.abs(left.tracks_on_row - trackCount) -
          Math.abs(right.tracks_on_row - trackCount) || left.id - right.id,
    )[0] ?? null
  )
}

/**
 * Which of the album's identifiers the release carries, and the edition that
 * matched: the album's Spotify album first, then its barcode, then its
 * MusicBrainz release group. A title never confirms an album. Null when no
 * identifier matches.
 */
export function confirmSonovaultRelease(
  release: SonovaultRelease,
  album: SonovaultAlbumIdentity,
): {
  confirmedBy: SonovaultAlbumConfirmation[]
  edition: Edition | null
} | null {
  const confirmedBy: SonovaultAlbumConfirmation[] = []
  const matches: Edition[] = []
  const { spotifyAlbumId } = album
  const spotify = spotifyAlbumId
    ? release.editions.find(
        (edition) =>
          edition.source === 'spotify' &&
          sameId(edition.external_id, spotifyAlbumId),
      )
    : undefined
  if (spotify) {
    confirmedBy.push('spotify-album')
    matches.push(spotify)
  }
  const upc = normalizedBarcode(album.upc)
  if (upc) {
    const barcoded = release.editions.filter(
      (edition) => normalizedBarcode(edition.barcode) === upc,
    )
    const preferred =
      barcoded.find((edition) => edition.source === 'spotify') ?? barcoded[0]
    if (preferred || normalizedBarcode(release.digital_upc) === upc) {
      confirmedBy.push('upc')
      if (preferred) matches.push(preferred)
    }
  }
  const groups = album.musicbrainzReleaseGroups.filter((group) =>
    release.musicbrainz_release_group_ids.some((id) => sameId(id, group)),
  )
  if (groups.length) {
    confirmedBy.push('musicbrainz-release-group')
    const grouped = closestEdition(
      release.editions.filter(
        (edition) =>
          edition.source === 'musicbrainz' &&
          edition.group_external_id !== null &&
          groups.some((group) =>
            sameId(group, edition.group_external_id ?? ''),
          ),
      ),
      album.trackCount,
    )
    if (grouped) matches.push(grouped)
  }
  if (!confirmedBy.length) return null
  return { confirmedBy, edition: matches[0] ?? null }
}

/**
 * The release's tracks that have a disc and track number, in that order and
 * numbered from 1, for alignment (SONO-20). A position held by two tracks
 * names neither, so both are left out.
 */
export function positionedReleaseTracks(
  release: Pick<SonovaultRelease, 'tracks'>,
): PluginTrack[] {
  const positioned = release.tracks.flatMap((entry) =>
    entry.disc_number !== null &&
    entry.track_number !== null &&
    entry.title.trim()
      ? [{ entry, disc: entry.disc_number, number: entry.track_number }]
      : [],
  )
  const keys = new Map<string, number>()
  for (const { disc, number } of positioned) {
    const key = `${disc}:${number}`
    keys.set(key, (keys.get(key) ?? 0) + 1)
  }
  return positioned
    .filter(({ disc, number }) => keys.get(`${disc}:${number}`) === 1)
    .sort((left, right) => left.disc - right.disc || left.number - right.number)
    .map(({ entry }, index) => ({
      externalId: String(entry.id),
      title: entry.title.trim(),
      position: index + 1,
      ...(entry.duration === null ? {} : { durationSec: entry.duration }),
      ...(entry.isrc ? { isrc: entry.isrc } : {}),
    }))
}

const numericId = /^[1-9]\d{0,15}$/
const mbid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export type SonovaultAlbumReferenceRow = {
  referenceType: SonovaultAlbumReferenceType
  externalId: string
  url: string | null
  editionId: number | null
  matchedEdition: boolean
}

/**
 * The album references a confirmed release gives (SONO-21): its own ID, its
 * digital UPC, and each edition's Discogs release and master, MusicBrainz
 * release and release group, Beatport release and Apple Music album. An ID
 * that is not in its service's format is left out.
 */
export function sonovaultAlbumReferences(
  release: SonovaultRelease,
  matchedEditionId: number | null,
): SonovaultAlbumReferenceRow[] {
  const rows = new Map<string, SonovaultAlbumReferenceRow>()
  const add = (
    referenceType: SonovaultAlbumReferenceType,
    externalId: string | null,
    url: string | null,
    edition: Edition | null,
  ) => {
    const id = externalId?.trim()
    if (!id) return
    const key = `${referenceType}:${id.toLowerCase()}`
    const matchedEdition = edition !== null && edition.id === matchedEditionId
    const existing = rows.get(key)
    // An ID several editions share is listed once, under the matched edition.
    if (existing && (existing.matchedEdition || !matchedEdition)) return
    rows.set(key, {
      referenceType,
      externalId: id,
      url,
      editionId: edition?.id ?? null,
      matchedEdition,
    })
  }
  add('sonovault-release', String(release.id), null, null)
  add('digital-upc', normalizedBarcode(release.digital_upc), null, null)
  for (const edition of release.editions) {
    const id = edition.external_id.trim()
    const group = edition.group_external_id?.trim() ?? null
    if (edition.source === 'discogs') {
      if (numericId.test(id))
        add(
          'discogs-release',
          id,
          `https://www.discogs.com/release/${id}`,
          edition,
        )
      if (group && numericId.test(group))
        add(
          'discogs-master',
          group,
          `https://www.discogs.com/master/${group}`,
          edition,
        )
    } else if (edition.source === 'musicbrainz') {
      if (mbid.test(id))
        add(
          'musicbrainz-release',
          id.toLowerCase(),
          `https://musicbrainz.org/release/${id.toLowerCase()}`,
          edition,
        )
      if (group && mbid.test(group))
        add(
          'musicbrainz-release-group',
          group.toLowerCase(),
          `https://musicbrainz.org/release-group/${group.toLowerCase()}`,
          edition,
        )
    } else if (edition.source === 'beatport') {
      if (numericId.test(id))
        add(
          'beatport-release',
          id,
          `https://www.beatport.com/release/-/${id}`,
          edition,
        )
    } else if (edition.source === 'applemusic') {
      if (numericId.test(id))
        add(
          'applemusic-album',
          id,
          `https://music.apple.com/album/${id}`,
          edition,
        )
    }
  }
  for (const group of release.musicbrainz_release_group_ids)
    if (mbid.test(group.trim()))
      add(
        'musicbrainz-release-group',
        group.trim().toLowerCase(),
        `https://musicbrainz.org/release-group/${group.trim().toLowerCase()}`,
        null,
      )
  return [...rows.values()]
}
