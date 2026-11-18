import { albumNameKey } from './album-import-candidates'

type ScrobbledName = {
  artist_key: string
  track_key: string
  album_ids: string[]
  has_unlinked_album: boolean
}

type AlbumRecording = {
  id: string
  title: string
  artists: string[]
  positions: { albumId: string; title: string; position: number }[]
}

// Only discard an explicit trailing guest credit. A version named anywhere
// in the suffix must not disappear along with the credit.
function titleCredit(title: string) {
  const match =
    /^(.*?)\s*(?:\((?:feat\.?|ft\.?|featuring)\s+([^()[\]]+)\)|\[(?:feat\.?|ft\.?|featuring)\s+([^()[\]]+)\]|\s+(?:feat\.?|ft\.?|featuring)\s+([^()[\]]+))$/i.exec(
      title,
    )
  const guest = match?.[2] ?? match?.[3] ?? match?.[4]
  if (
    !match?.[1]?.trim() ||
    !guest?.trim() ||
    /\b(?:mix|remix|edit|live|version|demo|dub|remaster(?:ed)?|instrumental|acoustic|mono|stereo|clean|explicit)\b|\s[-–—]\s/i.test(
      guest,
    )
  )
    return { title, guest: undefined }
  return { title: match[1].trim(), guest: guest.trim() }
}

export function splitScrobbleCredit(artist: string) {
  const match = /^(.+?)(?:,\s+|\s+(?:feat\.?|ft\.?|featuring)\s+)(.+)$/i.exec(
    artist,
  )
  return match?.[1] && match[2]
    ? { primary: match[1], guest: match[2] }
    : undefined
}

const key = (...values: string[]) => JSON.stringify(values)

function linkedAlbum(name: ScrobbledName) {
  return !name.has_unlinked_album && name.album_ids.length === 1
    ? name.album_ids[0]
    : undefined
}

/** Extra identity evidence from a release's actual track list, after direct name matching. */
export function createAlbumTrackAliasMatcher<T extends AlbumRecording>(
  recordings: T[],
  names: ScrobbledName[],
  manual: ReadonlyMap<string, string>,
) {
  type Slot = { recording: T; position: number; guest?: string }
  const slots = new Map<string, Slot[]>()
  for (const recording of recordings) {
    for (const entry of recording.positions) {
      const title = albumNameKey(entry.title)
      const parts = titleCredit(title)
      const id = key(entry.albumId, parts.title)
      const list = slots.get(id) ?? []
      // A position that disagrees with its attached library recording still
      // participates in the ambiguity check but cannot establish an identity.
      list.push({ recording, position: entry.position, guest: parts.guest })
      slots.set(id, list)
    }
  }

  // A comma can be part of a band's name. Accept a compound artist only if
  // the release credits the guest or an independent scrobble names the guest.
  const guests = new Map<string, Set<string>>()
  for (const name of names) {
    const album = linkedAlbum(name)
    const parts = titleCredit(name.track_key)
    if (
      !album ||
      !parts.guest ||
      manual.has(key(name.artist_key, name.track_key))
    )
      continue
    const id = key(album, name.artist_key, parts.title)
    const set = guests.get(id) ?? new Set<string>()
    set.add(parts.guest)
    guests.set(id, set)
  }

  return (name: ScrobbledName) => {
    const album = linkedAlbum(name)
    if (!album) return undefined
    const numbered = /^(\d{1,3})\s+[-–—]\s+(.+)$/.exec(name.track_key)
    const parts = titleCredit(numbered?.[2] ?? name.track_key)
    const compound = splitScrobbleCredit(name.artist_key)
    const candidates = slots.get(key(album, parts.title)) ?? []
    const [slot, other] = numbered
      ? candidates.filter((entry) => entry.position === Number(numbered[1]))
      : candidates
    if (!slot || other) return undefined
    const recording = slot.recording
    const title = titleCredit(albumNameKey(recording.title))
    if (title.title !== parts.title || title.guest !== slot.guest)
      return undefined
    const artists = recording.artists.map(albumNameKey)
    const primary = artists[0]
    if (!primary) return undefined
    const credit = name.artist_key === primary ? undefined : compound
    if (name.artist_key !== primary && credit?.primary !== primary)
      return undefined
    if (parts.guest && credit && parts.guest !== credit.guest) return undefined
    const guest = parts.guest ?? credit?.guest
    if (!guest) return recording
    if (slot.guest) return slot.guest === guest ? recording : undefined
    if (artists.length > 1)
      return artists.slice(1).includes(guest) ? recording : undefined

    const observed = guests.get(key(album, primary, parts.title))
    return observed?.size === 1 && observed.has(guest) ? recording : undefined
  }
}
