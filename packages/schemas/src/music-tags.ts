import { normalizeTagName, tagDisplayName } from './tags'

/** Release evidence wins; sparse releases may also display artist evidence. */
export const artistTagFallbackThreshold = 2

export type MusicDisplayTag = { name: string; source: 'album' | 'artist' }

export function uniqueMusicTags(names: readonly string[]): string[] {
  const seen = new Set<string>()
  return names.flatMap((name) => {
    const key = normalizeTagName(name)
    if (!key || seen.has(key)) return []
    seen.add(key)
    return [tagDisplayName(name)]
  })
}

export function musicDisplayTags(
  albumTags: readonly string[],
  artistTags: readonly string[],
): MusicDisplayTag[] {
  const release = uniqueMusicTags(albumTags)
  const result: MusicDisplayTag[] = release.map((name) => ({
    name,
    source: 'album',
  }))
  if (release.length >= artistTagFallbackThreshold) return result
  const present = new Set(release.map(normalizeTagName))
  for (const name of uniqueMusicTags(artistTags)) {
    if (!present.has(normalizeTagName(name)))
      result.push({ name, source: 'artist' })
  }
  return result
}
