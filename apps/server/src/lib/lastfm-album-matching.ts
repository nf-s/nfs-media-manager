import type { LastfmLinkStrategy } from '@repo/schemas/lastfm'
import { albumNameKey } from './album-import-candidates'

export type MatchAlbum = {
  id: string
  title: string
  artists: string[]
  tracks: string[]
}

export type MatchGroup = {
  artistName: string
  albumName: string
  /** Distinct scrobbled track names. */
  tracks: string[]
}

export type AlbumMatch =
  | { albumId: string; strategy: LastfmLinkStrategy }
  /** Several albums fit equally well; an empty list means nothing fits. */
  | { albumId: null; candidates: string[] }

const MAX_CANDIDATES = 10

const LETTERS: Record<string, string> = {
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ß: 'ss',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  þ: 'th',
}

/** Case, accents, apostrophes, punctuation and `&` do not distinguish names. */
export function plainKey(value: string) {
  const plain = value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[æœøßđðłþ]/g, (letter) => LETTERS[letter] ?? letter)
    .replace(/['’‘`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  // Titles made only of symbols keep their raw form.
  return plain || albumNameKey(value)
}

const EDITION_WORDS =
  /\b(deluxe|edition|version|remaster|remastered|expanded|anniversary|bonus|special|explicit|clean|reissue|re-issue|mono|stereo|(?:disc|disk|cd)\s*\d*|digital|extended|complete|collectors?|limited|original|international|japan|japanese|uk|us|ep|e\.p\.|lp|single|vinyl|redux|legacy)\b/i
const TRAILING_BRACKET = /\s*[([]([^()[\]]*)[)\]]\s*$/
const TRAILING_DASH = /\s+[-–—:]\s+([^-–—:]+)$/
const TRAILING_WORDS =
  /\s+((cd|disc|disk)\s*\d+|e\.?p\.?|lp|(deluxe|remastered|expanded|special|anniversary)(\s+(edition|version))?)$/i

function stripEdition(title: string) {
  let current = title.trim()
  for (;;) {
    const bracket = TRAILING_BRACKET.exec(current)
    const dash = TRAILING_DASH.exec(current)
    const next =
      bracket && EDITION_WORDS.test(bracket[1] ?? '')
        ? current.slice(0, bracket.index)
        : dash && EDITION_WORDS.test(dash[1] ?? '')
          ? current.slice(0, dash.index)
          : current.replace(TRAILING_WORDS, '')
    const trimmed = next.trim()
    if (!trimmed || trimmed === current) return current
    current = trimmed
  }
}

/** The title without edition, disc or format qualifiers. */
export function baseTitleKey(title: string) {
  return plainKey(stripEdition(title))
}

export function artistNameKey(name: string) {
  return plainKey(name).replace(/^the /, '')
}

const ARTIST_SEPARATOR =
  /\s*(?:,|;|\/|&|\+|\s(?:and|with|x|vs\.?|feat\.?|ft\.?|featuring)\s)\s*/i

/** The whole credit and each collaborator named in it. */
export function artistKeys(name: string) {
  return [
    artistNameKey(name),
    ...name
      .split(ARTIST_SEPARATOR)
      .map(artistNameKey)
      .filter((key) => key.length > 1),
  ]
}

const TRACK_QUALIFIER =
  /\s+[-–—]\s+[^-–—]*\b(remaster|remastered|version|edit|mix|live|feat|bonus|mono|stereo|demo|single)\b[^-–—]*$/i

function trackKey(title: string) {
  let current = title.replace(TRACK_QUALIFIER, '')
  while (TRAILING_BRACKET.test(current)) {
    const next = current.replace(TRAILING_BRACKET, '').trim()
    if (!next) break
    current = next
  }
  return plainKey(current)
}

const VARIANTS = [
  /\blive\b/,
  /\b(remix|remixes|remixed)\b/,
  /\b(best of|greatest hits|anthology|collection)\b/,
]

/** Live, remix and compilation releases are not editions of the studio album. */
function variantKey(title: string) {
  const plain = plainKey(title)
  return VARIANTS.map((pattern) => (pattern.test(plain) ? '1' : '0')).join('')
}

function wordPrefix(shorter: string, longer: string) {
  return shorter.length >= 4 && longer.startsWith(`${shorter} `)
}

type Indexed = {
  id: string
  exactTitle: string
  plainTitle: string
  baseTitle: string
  variant: string
  exactArtists: Set<string>
  plainArtists: Set<string>
  artistParts: Set<string>
  tracks: Set<string>
}

type Scored = {
  album: Indexed
  title: 'exact' | 'plain' | 'base' | 'prefix' | 'none'
  artist: 'exact' | 'plain' | 'part' | 'none'
  /** Scrobbled tracks on the album. */
  overlap: number
  /** The same, without a track that shares the album's title. */
  distinctOverlap: number
  sameVariant: boolean
}

function add<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

// Earlier rules are stricter. The first rule that any album satisfies decides.
const RULES: Array<{
  strategy: LastfmLinkStrategy
  test(scored: Scored, trackCount: number): boolean
}> = [
  {
    strategy: 'exact',
    test: ({ title, artist }) => title === 'exact' && artist === 'exact',
  },
  {
    strategy: 'normalized',
    test: ({ title, artist }) =>
      (title === 'exact' || title === 'plain') &&
      (artist === 'exact' || artist === 'plain'),
  },
  {
    strategy: 'edition',
    test: ({ title, artist }) =>
      title !== 'prefix' && title !== 'none' && artist !== 'none',
  },
  {
    strategy: 'title-tracks',
    // A title track alone is a coincidence between unrelated releases.
    test: ({ title, artist, overlap, distinctOverlap }, trackCount) =>
      title !== 'prefix' &&
      title !== 'none' &&
      artist === 'none' &&
      distinctOverlap >= 1 &&
      overlap * 2 >= trackCount,
  },
  {
    strategy: 'title-prefix',
    test: ({ title, artist, overlap, sameVariant }, trackCount) =>
      title === 'prefix' &&
      artist !== 'none' &&
      sameVariant &&
      overlap >= 1 &&
      overlap * 2 >= trackCount,
  },
  {
    strategy: 'tracks',
    test: ({ artist, overlap, sameVariant }, trackCount) =>
      artist !== 'none' &&
      sameVariant &&
      overlap >= 3 &&
      overlap * 4 >= trackCount * 3,
  },
]

/**
 * Builds a matcher from the library's albums. A scrobbled artist and album
 * name links to one album by title, credited artist and shared track titles;
 * see `RULES` for the order.
 */
export function createAlbumMatcher(albums: MatchAlbum[]) {
  const byArtist = new Map<string, Indexed[]>()
  const byBaseTitle = new Map<string, Indexed[]>()
  for (const album of albums) {
    const indexed: Indexed = {
      id: album.id,
      exactTitle: albumNameKey(album.title),
      plainTitle: plainKey(album.title),
      baseTitle: baseTitleKey(album.title),
      variant: variantKey(album.title),
      exactArtists: new Set(album.artists.map(albumNameKey)),
      plainArtists: new Set(album.artists.map(artistNameKey)),
      artistParts: new Set(album.artists.flatMap(artistKeys)),
      tracks: new Set(album.tracks.map(trackKey)),
    }
    for (const key of indexed.artistParts) add(byArtist, key, indexed)
    add(byBaseTitle, indexed.baseTitle, indexed)
  }

  return function match(group: MatchGroup): AlbumMatch {
    const exactTitle = albumNameKey(group.albumName)
    const plainTitle = plainKey(group.albumName)
    const baseTitle = baseTitleKey(group.albumName)
    const exactArtist = albumNameKey(group.artistName)
    const plainArtist = artistNameKey(group.artistName)
    const parts = artistKeys(group.artistName)
    const variant = variantKey(group.albumName)
    const tracks = [...new Set(group.tracks.map(trackKey))]
    const considered = new Set<Indexed>([
      ...parts.flatMap((key) => byArtist.get(key) ?? []),
      ...(byBaseTitle.get(baseTitle) ?? []),
    ])
    const scored = [...considered].map((album): Scored => {
      const shared = tracks.filter((key) => album.tracks.has(key))
      return {
        album,
        title:
          album.exactTitle === exactTitle
            ? 'exact'
            : album.plainTitle === plainTitle
              ? 'plain'
              : album.baseTitle === baseTitle
                ? 'base'
                : wordPrefix(album.baseTitle, baseTitle) ||
                    wordPrefix(baseTitle, album.baseTitle)
                  ? 'prefix'
                  : 'none',
        artist: album.exactArtists.has(exactArtist)
          ? 'exact'
          : album.plainArtists.has(plainArtist)
            ? 'plain'
            : parts.some((key) => album.artistParts.has(key))
              ? 'part'
              : 'none',
        overlap: shared.length,
        distinctOverlap: shared.filter((key) => key !== baseTitle).length,
        sameVariant: album.variant === variant,
      }
    })
    for (const rule of RULES) {
      const fits = scored.filter((item) => rule.test(item, tracks.length))
      if (!fits.length) continue
      // Among equal titles, prefer the album sharing the most scrobbled
      // tracks, then the one whose own title has no edition qualifier.
      const rank = (item: Scored) =>
        item.overlap * 2 +
        (item.album.plainTitle === item.album.baseTitle ? 1 : 0)
      const best = Math.max(...fits.map(rank))
      const winners = fits.filter((item) => rank(item) === best)
      const [winner] = winners
      return winner && winners.length === 1
        ? { albumId: winner.album.id, strategy: rule.strategy }
        : {
            albumId: null,
            candidates: winners
              .map((item) => item.album.id)
              .sort()
              .slice(0, MAX_CANDIDATES),
          }
    }
    return { albumId: null, candidates: [] }
  }
}
