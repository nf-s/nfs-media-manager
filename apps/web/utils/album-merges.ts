import {
  AlbumMergePlanSchema,
  AlbumNameRefSchema,
  type AlbumMergeBlock,
  type AlbumMergeCaution,
  type AlbumMergePlan,
  type AlbumNameRef,
} from '@repo/schemas/album-merges'
import { LibraryChangeSchema } from '@repo/schemas/library-changes'
import { formatCount, formatItemCount } from '@repo/ui/lib/format'
import { fetchApiData } from './api'

const base = '/api/v1/library-changes'

function post(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) }
}

export type AlbumMergeSelection = {
  albumIds: string[]
  /** The album to keep. The server chooses one when omitted. */
  targetId?: string
  /** Track names follow the album names that move. The server does when omitted. */
  follow?: boolean
}

/** What merging the selected albums would do, and any reason to review it. */
export function planAlbumMerge(
  apiBaseUrl: string,
  selection: AlbumMergeSelection,
) {
  return fetchApiData(
    apiBaseUrl,
    `${base}/album-merges/plan`,
    AlbumMergePlanSchema,
    post(selection),
  )
}

/** Makes the other albums editions of the album to keep. */
export function mergeAlbums(
  apiBaseUrl: string,
  request: AlbumMergeSelection & { reviewed: boolean },
) {
  return fetchApiData(
    apiBaseUrl,
    `${base}/album-merges`,
    LibraryChangeSchema,
    post(request),
  )
}

/** Gives an edition its own record again. */
export function separateAlbumEdition(apiBaseUrl: string, albumId: string) {
  return fetchApiData(
    apiBaseUrl,
    `${base}/album-merges/separate`,
    LibraryChangeSchema,
    post({ albumId }),
  )
}

export type AlbumNameMoveSelection = AlbumNameRef & {
  /** The album the name moves to. */
  albumId: string
  follow?: boolean
}

/** What moving a scrobbled album name to an album would do. */
export function planAlbumNameMove(
  apiBaseUrl: string,
  selection: AlbumNameMoveSelection,
) {
  return fetchApiData(
    apiBaseUrl,
    `${base}/album-names/plan`,
    AlbumMergePlanSchema,
    post(selection),
  )
}

/** Moves a scrobbled album name to an album, with the track names under it unless `follow` is false. */
export function moveAlbumName(
  apiBaseUrl: string,
  request: AlbumNameMoveSelection & { reviewed: boolean },
) {
  return fetchApiData(
    apiBaseUrl,
    `${base}/album-names`,
    LibraryChangeSchema,
    post(request),
  )
}

/**
 * A scrobbled album name as one record ID, so a name move can travel through
 * the shared merge review the way album IDs do.
 */
export function albumNameKey({ artistName, albumName }: AlbumNameRef) {
  return JSON.stringify({ artistName, albumName })
}

/** The album name an `albumNameKey` stands for, or null for any other ID. */
export function parseAlbumNameKey(key: string): AlbumNameRef | null {
  try {
    const parsed = AlbumNameRefSchema.safeParse(JSON.parse(key))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

const quoted = (title: string) => `“${title}”`
const listed = new Intl.ListFormat('en', {
  style: 'long',
  type: 'conjunction',
})

/** Quoted titles, the first `max` of them, then how many more. */
export function quotedTitles(titles: readonly string[], max = 3) {
  const shown = titles.slice(0, max).map(quoted)
  const more = titles.length - shown.length
  return listed.format(
    more > 0 ? [...shown, `${formatCount(more)} more`] : shown,
  )
}

/** One sentence of evidence against an album merge. */
export function describeAlbumMergeCaution(
  caution: AlbumMergeCaution,
  plan: Pick<AlbumMergePlan, 'albums' | 'targetId'>,
): string {
  const title = (id: string) =>
    plan.albums.find((album) => album.id === id)?.title ?? 'An album'
  switch (caution.code) {
    case 'version':
      return `${listed.format(caution.words.map(quoted))} ${caution.words.length === 1 ? 'is' : 'are'} in some titles only.`
    case 'artists':
      return `The artists differ: ${caution.names.join(', ')}.`
    case 'tracks': {
      const kept = quoted(title(plan.targetId))
      return caution.albums
        .map(
          (album) =>
            `${quoted(title(album.albumId))} and ${kept} share ${formatCount(album.shared)} of ${formatCount(album.listed)} track titles.`,
        )
        .join(' ')
    }
    case 'elsewhere': {
      const shown = caution.names.map(
        (name) => `${quoted(name.trackName)} on ${quoted(name.albumTitle)}`,
      )
      const more = caution.count - shown.length
      const names = listed.format(
        more > 0 ? [...shown, `${formatCount(more)} more`] : shown,
      )
      return caution.count === 1
        ? `1 track name that would follow is on another album: ${names}.`
        : `${formatCount(caution.count)} track names that would follow are on other albums: ${names}.`
    }
    case 'separate':
      return 'Some of these albums were kept separate.'
  }
}

type FollowPlan = Pick<
  AlbumMergePlan,
  'albums' | 'targetId' | 'names' | 'also' | 'unmatched'
>

/** Where the scrobbled names come from: the album names that move. */
function scrobbledUnder(plan: FollowPlan) {
  return plan.names.length
    ? quotedTitles(plan.names.map((name) => name.albumName))
    : 'these album names'
}

const nameCount = (count: number) =>
  formatItemCount(count, { one: 'name', other: 'names' })

/** The track names that follow the album names onto the album's matching tracks. */
export function describeAlbumMergeFollows(plan: FollowPlan) {
  const kept = plan.albums.find((album) => album.id === plan.targetId)
  return `${nameCount(plan.also.length)} scrobbled under ${scrobbledUnder(plan)}, onto the matching tracks${kept ? ` of ${quoted(kept.title)}` : ''}: ${quotedTitles(plan.also.map((name) => name.trackName))}.`
}

/** The track names under the album names that match no track and stay where they are. */
export function describeAlbumMergeUnmatched(plan: FollowPlan) {
  const kept = plan.albums.find((album) => album.id === plan.targetId)
  const titles = [...new Set(plan.unmatched.map((name) => name.trackName))]
  const one = titles.length === 1
  return `${nameCount(titles.length)} scrobbled under ${scrobbledUnder(plan)} ${one ? 'matches' : 'match'} no track${kept ? ` of ${quoted(kept.title)}` : ''} and ${one ? 'stays where it is' : 'stay where they are'}: ${quotedTitles(titles)}.`
}

/** Why the albums cannot be merged. */
export const albumMergeBlockLabels: Record<AlbumMergeBlock, string> = {
  hidden: 'Albums removed from the library cannot be merged.',
  'same-record': 'These albums are one record already.',
}
