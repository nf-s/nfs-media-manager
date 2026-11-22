import { normalizeTagName, tagDisplayName } from './tags'

/** Release evidence wins; sparse releases may also display artist evidence. */
export const artistTagFallbackThreshold = 2

export type MusicDisplayTag = {
  name: string
  source: 'track' | 'album' | 'artist'
}

export function uniqueMusicTags(names: readonly string[]): string[] {
  const seen = new Set<string>()
  return names.flatMap((name) => {
    const key = normalizeTagName(name)
    if (!key || seen.has(key)) return []
    seen.add(key)
    return [tagDisplayName(name)]
  })
}

/**
 * A track's own tags first, then its album's, then its artists' when the
 * album has fewer than two tags. A name is shown once, at its first source.
 */
export function musicDisplayTags(
  albumTags: readonly string[],
  artistTags: readonly string[],
  trackTags: readonly string[] = [],
): MusicDisplayTag[] {
  const release = uniqueMusicTags(albumTags)
  const present = new Set<string>()
  const result: MusicDisplayTag[] = []
  function add(name: string, source: MusicDisplayTag['source']) {
    const key = normalizeTagName(name)
    if (present.has(key)) return
    present.add(key)
    result.push({ name, source })
  }
  for (const name of uniqueMusicTags(trackTags)) add(name, 'track')
  for (const name of release) add(name, 'album')
  if (release.length >= artistTagFallbackThreshold) return result
  for (const name of uniqueMusicTags(artistTags)) add(name, 'artist')
  return result
}
