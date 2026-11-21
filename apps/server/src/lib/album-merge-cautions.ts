import type { AlbumMergeCaution } from '@repo/schemas/album-merges'
import {
  albumTrackTitleKey,
  artistKeys,
  baseTitleKey,
  plainKey,
} from './lastfm-album-matching'
import { trackVersionQualifiers } from './track-matching'

// A shorter track list with fewer than half its titles on the other list is
// treated as another release.
const SHARED_TRACKS = 0.5

/** An album as the cautions compare it. */
export type CautionAlbum = { id: string; artists: string[]; tracks: string[] }

/** Version words in an album title: bracketed or dashed notes and edition notes. */
function versionWords(title: string) {
  const words = new Map(
    trackVersionQualifiers(title).map((word) => [plainKey(word), word]),
  )
  const plain = plainKey(title)
  const base = baseTitleKey(title)
  const edition = plain.startsWith(base) ? plain.slice(base.length).trim() : ''
  if (edition && ![...words.keys()].some((key) => key.includes(edition)))
    words.set(edition, edition)
  return words
}

/** A version word, such as Deluxe or Live, in some titles only. */
export function albumVersionCaution(titles: string[]): AlbumMergeCaution[] {
  const all = titles.map(versionWords)
  const words = new Map<string, string>()
  for (const own of all)
    for (const [key, word] of own)
      if (!words.has(key) && !all.every((other) => other.has(key)))
        words.set(key, word)
  return words.size ? [{ code: 'version', words: [...words.values()] }] : []
}

/** Albums, or scrobbled names, credited to none of the kept album's artists. */
export function albumArtistCaution(
  target: CautionAlbum,
  credits: string[][],
): AlbumMergeCaution[] {
  const targetKeys = new Set(target.artists.flatMap(artistKeys))
  // An album without a credited artist says nothing either way.
  const different = credits.filter(
    (artists) =>
      targetKeys.size > 0 &&
      artists.length > 0 &&
      !artists.flatMap(artistKeys).some((key) => targetKeys.has(key)),
  )
  const names = [
    ...new Set(
      [target.artists, ...different].map((artists) => artists.join(', ')),
    ),
  ]
  return different.length && names.length > 1
    ? [{ code: 'artists', names }]
    : []
}

/**
 * Compares each album's track list with the album to keep: the share of the
 * shorter list's titles, without version notes, found on the longer one.
 */
export function albumTrackCaution(
  target: CautionAlbum,
  others: CautionAlbum[],
): AlbumMergeCaution[] {
  const keys = (album: CautionAlbum) =>
    new Set(album.tracks.map(albumTrackTitleKey))
  const kept = keys(target)
  const albums = others.flatMap((album) => {
    const own = keys(album)
    const [shorter, longer] = own.size <= kept.size ? [own, kept] : [kept, own]
    if (!shorter.size) return []
    const shared = [...shorter].filter((key) => longer.has(key)).length
    return shared < shorter.size * SHARED_TRACKS
      ? [{ albumId: album.id, shared, listed: shorter.size }]
      : []
  })
  return albums.length ? [{ code: 'tracks', albums }] : []
}
