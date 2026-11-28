// The preview library: wipes the disposable preview database (except the
// Better Auth tables) and fills it with invented albums, tracks, films,
// playlists, scrobbles, provider state, jobs and subscriptions. Rows are
// written directly or through services that never call a provider; every
// network request is refused. Credentials stored here are obviously fake.
// The preview command (`corepack pnpm preview`) runs it after the migrations
// and the initial account seed.
import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { PluginResultSchema, type JsonValue } from '@repo/media-plugin-sdk'
import { ArtistProfileSchema } from '@repo/schemas/artist-profiles'
import {
  TidalSuggestionSchema,
  type TidalSuggestion,
} from '@repo/schemas/tidal'
import { env } from '@/env'
import { db } from '@/lib/db'
import { createStableId } from '@/lib/media-utils'
import * as schema from '@/schemas/db'
import { assertPreviewDatabase } from './preview-database'

assertPreviewDatabase(env)

globalThis.fetch = () =>
  Promise.reject(new Error('Preview seed makes no network requests'))

type JsonRecord = { [key: string]: JsonValue }
type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

const USER_ID = 'initial-admin'
const LISTENER = 'harbour-listener'
const NOW = Date.now()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const at = (msAgo: number) => new Date(NOW - msAgo)
const daysAgo = (days: number) => at(days * DAY)

// Deterministic randomness, so every run produces the same library.
let seed = 0x5eed1234
function random() {
  seed = (seed + 0x6d2b79f5) | 0
  let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296
}
const between = (low: number, high: number) =>
  Math.floor(low + random() * (high - low + 1))
function pick<T>(
  list: readonly T[],
  index = Math.floor(random() * list.length),
): T {
  const value = list[index % list.length]
  if (value === undefined) throw new Error('Empty list')
  return value
}
function shuffle<T>(list: readonly T[]): T[] {
  const result = [...list]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1))
    const current = result[index]
    const swapped = result[other]
    if (current === undefined || swapped === undefined) continue
    result[index] = swapped
    result[other] = current
  }
  return result
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const ALPHANUMERIC = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
]
// A 22-character Spotify-shaped identifier that starts with "pv".
const spotifyId = (name: string) => {
  const digest = hash(name)
  return `pv${Array.from({ length: 20 }, (_, index) =>
    pick(ALPHANUMERIC, parseInt(digest.slice(index * 2, index * 2 + 2), 16)),
  ).join('')}`
}
const uuidFor = (name: string) => {
  const value = hash(name)
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`
}
const numericId = (name: string, base: number) =>
  base + (parseInt(hash(name).slice(0, 7), 16) % 900_000)
const isoDay = (date: Date) => date.toISOString().slice(0, 10)

// Flat generated covers in cool greys, slates, blues and ambers.
const PALETTE = [
  ['#3b4a5a', '#c9d3dd'],
  ['#1f2a37', '#f2b84b'],
  ['#5b6b7c', '#e7ecf1'],
  ['#2d3e57', '#8fb3d9'],
  ['#6b5a45', '#f4d29c'],
  ['#44505c', '#d98b3a'],
  ['#25313f', '#a7b8c9'],
  ['#7a8794', '#1d2733'],
  ['#3a4f6b', '#f0c987'],
  ['#8c97a3', '#2b3846'],
  ['#e3e7ec', '#41546b'],
  ['#b9c3cd', '#2a3542'],
] as const
function artwork(name: string, height = 300) {
  const value = parseInt(hash(name).slice(0, 8), 16)
  const [background, foreground] = pick(PALETTE, value)
  const offset = (value >>> 8) % 80
  const size = (value >>> 16) % 50
  const shapes = [
    `<circle cx="150" cy="${height / 2 - 40 + offset}" r="${55 + size}" fill="${foreground}"/>`,
    `<rect x="0" y="${height / 2 + offset - 40}" width="300" height="${40 + size}" fill="${foreground}"/>`,
    `<path d="M0 ${height} L150 ${70 + offset} L300 ${height} Z" fill="${foreground}" opacity="0.85"/>`,
    `<rect x="${60 + size / 2}" y="${60 + offset / 2}" width="${120 - size / 2}" height="${120 - size / 2}" fill="none" stroke="${foreground}" stroke-width="14"/>`,
  ]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 ${height}"><rect width="300" height="${height}" fill="${background}"/>${pick(shapes, value >>> 24)}</svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

// ---------------------------------------------------------------- music data

const ARTISTS = [
  {
    name: 'Mira Kestrel',
    albums: 8,
    from: 2003,
    country: 'GB',
    type: 'Person',
  },
  {
    name: 'Fixture & Sons',
    albums: 7,
    from: 1974,
    country: 'IE',
    type: 'Group',
  },
  { name: 'Halden Row', albums: 6, from: 1996, country: 'NO', type: 'Group' },
  {
    name: 'Tomas Ellery',
    albums: 5,
    from: 2008,
    country: 'CA',
    type: 'Person',
  },
  {
    name: 'Juniper Vale',
    albums: 5,
    from: 1988,
    country: 'US',
    type: 'Person',
  },
  {
    name: 'Northline Atlas',
    albums: 4,
    from: 2011,
    country: 'AU',
    type: 'Group',
  },
  { name: 'Corvid Choir', albums: 4, from: 1979, country: 'GB', type: 'Group' },
  {
    name: 'Ines Marlowe',
    albums: 4,
    from: 2014,
    country: 'PT',
    type: 'Person',
  },
  {
    name: 'Slate & Ember',
    albums: 3,
    from: 2016,
    country: 'NZ',
    type: 'Group',
  },
  { name: 'Odalys Fenn', albums: 3, from: 1999, country: 'FR', type: 'Person' },
  {
    name: 'Quiet Harbour Unit',
    albums: 3,
    from: 2019,
    country: 'NL',
    type: 'Group',
  },
  {
    name: 'Rook Abernathy',
    albums: 2,
    from: 2003,
    country: 'US',
    type: 'Person',
  },
  {
    name: 'Velvet Meridian',
    albums: 2,
    from: 1983,
    country: 'JP',
    type: 'Group',
  },
  {
    name: 'Sable Tamsin',
    albums: 1,
    from: 2024,
    country: 'SE',
    type: 'Person',
  },
] as const
// Scrobbled and playlist artists that are not in the album library.
const OUTSIDE = [
  { artist: 'Lowland Static', album: 'Coastal Interference' },
  { artist: 'Perrin Vale', album: 'Weekend Radio' },
  { artist: 'The Margin Notes', album: null },
] as const

const TITLE_A = [
  'Amber',
  'Quiet',
  'Paper',
  'Northern',
  'Slow',
  'Copper',
  'Distant',
  'Winter',
  'Hollow',
  'Bright',
  'Silver',
  'Low',
  'Glass',
  'Salt',
  'Iron',
  'Late',
  'Pale',
  'Open',
  'Second',
  'Lantern',
]
const TITLE_B = [
  'Signals',
  'Rooms',
  'Weather',
  'Static',
  'Orbits',
  'Tides',
  'Maps',
  'Hours',
  'Engines',
  'Gardens',
  'Letters',
  'Bridges',
  'Fields',
  'Wires',
  'Rivers',
  'Mirrors',
  'Seasons',
  'Harbours',
  'Stations',
  'Shorelines',
]
const TRACK_A = [
  'Night',
  'Morning',
  'Blue',
  'Small',
  'Long',
  'Falling',
  'Hidden',
  'Golden',
  'Empty',
  'Little',
  'Restless',
  'Patient',
  'Faraway',
  'Borrowed',
  'Sleeping',
  'Turning',
]
const TRACK_B = [
  'Train',
  'Light',
  'Hands',
  'Window',
  'Weather',
  'Coast',
  'Garden',
  'Radio',
  'Engine',
  'Lantern',
  'Ferry',
  'Letter',
  'Kitchen',
  'Mountain',
  'Ceiling',
  'Signal',
]
const TAGS = [
  'indie rock',
  'dream pop',
  'ambient',
  'post-rock',
  'synthpop',
  'folk',
  'chamber pop',
  'shoegaze',
  'krautrock',
  'jazz fusion',
  'electronic',
  'downtempo',
  'singer-songwriter',
  'art rock',
  'minimalism',
  'field recordings',
  'slowcore',
  'new wave',
  'trip hop',
  'modern classical',
  'lo-fi',
  'psychedelic',
  'drone',
  'post-punk',
]
const LABELS = [
  'Fixture Records',
  'Placeholder Audio',
  'Grey Pier Recordings',
  'Lantern House',
  'Slow Tide Music',
]

type Plan = 'scraped' | 'legacy' | 'none'
interface TrackSeed {
  title: string
  durationSec: number
  spotifyId: string
}
interface AlbumSeed {
  id: string
  title: string
  spotifyTitle: string
  artists: string[]
  released: Date
  dateAdded: Date
  tracks: TrackSeed[]
  spotifyId: string
  tags: string[]
  plan: Plan
  providers: string[]
  hidden: boolean
  artwork: string | null
  favourite: number
  scrobbled: boolean
}

const usedTitles = new Set<string>()
function albumTitle() {
  for (;;) {
    const title = `${pick(TITLE_A)} ${pick(TITLE_B)}`
    if (!usedTitles.has(title)) {
      usedTitles.add(title)
      return title
    }
  }
}
function trackList(albumId: string, count: number): TrackSeed[] {
  const used = new Set<string>()
  return Array.from({ length: count }, (_, index) => {
    let title = `${pick(TRACK_A)} ${pick(TRACK_B)}`
    while (used.has(title)) title = `${pick(TRACK_A)} ${pick(TRACK_B)}`
    used.add(title)
    if (index === count - 1 && random() < 0.25) title = `${title} (Reprise)`
    return {
      title,
      durationSec: between(118, 431),
      spotifyId: spotifyId(`${albumId}:track:${index}`),
    }
  })
}

const specials = new Map<string, string>([
  ['Mira Kestrel:0', 'Harbour Lights'],
  ['Mira Kestrel:4', '夜の港'],
  [
    'Fixture & Sons:3',
    'The Long Unfinished Conversation Between the Lighthouse Keeper and the Northern Sea (Expanded Edition)',
  ],
  ['Rook Abernathy:0', 'Untitled Demos 2003'],
])
const albums: AlbumSeed[] = []
for (const entry of ARTISTS) {
  const span = Math.max(1, 2026 - entry.from)
  for (let index = 0; index < entry.albums; index += 1) {
    const title = specials.get(`${entry.name}:${index}`) ?? albumTitle()
    usedTitles.add(title)
    const year = Math.min(
      2026,
      entry.from +
        Math.round((index * span) / Math.max(1, entry.albums - 1 || 1)),
    )
    albums.push(makeAlbum(title, [entry.name], year))
  }
}
// One album credited to two artists.
albums.push(
  makeAlbum('Tidewater Duets', ['Mira Kestrel', 'Tomas Ellery'], 2021),
)
// One hidden album, kept from a legacy import.
albums.push(makeAlbum('Rehearsal Tapes', ['Halden Row'], 2001))

function makeAlbum(title: string, artists: string[], year: number): AlbumSeed {
  const id = `pv-album-${String(albums.length + 1).padStart(2, '0')}`
  const month = year === 2026 ? between(0, 9) : between(0, 11)
  const released = new Date(Date.UTC(year, month, between(1, 28)))
  const earliest = Math.max(released.getTime(), NOW - 7.3 * 365 * DAY)
  const dateAdded = new Date(between(earliest, NOW - DAY))
  return {
    id,
    title,
    spotifyTitle: title,
    artists,
    released,
    dateAdded,
    tracks: trackList(id, between(6, 14)),
    spotifyId: spotifyId(`${id}:album`),
    tags: [],
    plan: 'scraped',
    providers: [],
    hidden: false,
    artwork: artwork(id),
    favourite: random() < 0.2 ? between(4, 9) : 1 + random() * 2,
    scrobbled: true,
  }
}

function albumBy(title: string) {
  const found = albums.find((item) => item.title === title)
  if (!found) throw new Error(`Missing album ${title}`)
  return found
}
// Recent additions, so "Added" sorting shows new albums.
for (const item of shuffle(albums).slice(0, 6))
  item.dateAdded = new Date(
    Math.max(item.released.getTime() + DAY, NOW - between(1, 28) * DAY),
  )
const harbour = albumBy('Harbour Lights')
harbour.spotifyTitle = 'Harbour Lights (2024 Remaster)'
harbour.favourite = 10
const bare = albumBy('Untitled Demos 2003')
bare.artwork = null
bare.plan = 'none'
bare.scrobbled = false
const hidden = albumBy('Rehearsal Tapes')
hidden.hidden = true
hidden.plan = 'legacy'
hidden.scrobbled = false

// Plans: about 70% scraped by several providers, the rest legacy-imported
// (stored data, never scraped) or bare.
const ordered = shuffle(
  albums.filter((item) => item !== bare && item !== hidden),
)
ordered.forEach((item, index) => {
  if (item === harbour) return
  if (index < 41) item.plan = 'scraped'
  else if (index < 52) item.plan = 'legacy'
  else item.plan = 'none'
})
for (const item of albums) {
  if (item.plan === 'scraped')
    item.providers = [
      'spotify',
      ...shuffle(['musicbrainz', 'discogs', 'lastfm', 'serply']).slice(
        0,
        between(1, 3),
      ),
    ]
  else if (item.plan === 'legacy') item.providers = ['spotify']
  if (item.plan !== 'none') item.tags = shuffle(TAGS).slice(0, between(1, 9))
  if (item.plan === 'none' && item !== bare && random() < 0.5)
    item.artwork = null
}
harbour.providers = ['spotify', 'musicbrainz', 'discogs', 'lastfm', 'serply']
harbour.tags = [
  'dream pop',
  'synthpop',
  'synth pop',
  'chamber pop',
  'ambient',
  'seen live',
  'indie rock',
  'slowcore',
  'shoegaze',
]
albumBy('夜の港').tags = ['city pop', 'synthpop', 'dream pop']
// A tag to merge, a tag to hide and one album with Japanese tags.
for (const item of shuffle(albums.filter((entry) => entry.tags.length)).slice(
  0,
  5,
))
  item.tags = [...new Set([...item.tags.slice(0, 7), 'synth pop', 'seen live'])]
// A few listened-to albums with no scrobbles.
for (const item of shuffle(
  albums.filter((entry) => entry.plan === 'scraped' && entry !== harbour),
).slice(0, 3))
  item.scrobbled = false

// ------------------------------------------------------------------- films

const PEOPLE = {
  directors: [
    'Anouk Brennagh',
    'Dariusz Holt',
    'Celeste Varga',
    'Matthias Orrin',
    'Ruth Calloway-Penn',
    'Idris Fennimore',
    'Leontine Aubrey',
    'Joaquim Saltash',
  ],
  writers: [
    'Petra Lindqvist-Mori',
    'Hollis Wren',
    'Benedikt Szabo-Lane',
    'Marisol Quayle',
  ],
  actors: [
    'Elodie Marchbank',
    'Kofi Ashgrove',
    'Tamsin Rookwood',
    'Viggo Hallander',
    'Priya Castellane',
    'Oren Blackwell',
    'Signe Thornbury',
    'Lucan Merriweather',
    'Annika Dovecote',
    'Felix Okafor-Byrne',
    'Rosalind Ketteridge',
    'Teodor Vashenko',
    'Margit Sallow',
    'Desmond Fairweather',
    'Ilse Brannagh',
    'Caspian Lorne',
    'Noor Halloway',
    'August Penhallow',
  ],
} as const
const FILM_TITLES = [
  'The Paper Lantern',
  'Salt and Static',
  'A Map of Quiet Rooms',
  'Copper Season',
  'The Winter Ferry',
  'Low Tide at Ostrava Bay',
  'Second Signal',
  'The Glass Orchard',
  'Northern Clockwork',
  'The Paper Lantern II: Embers',
  'Distant Engines',
  'Pale Harbour',
  'The Cartographer’s Daughter',
  'Iron Kitchen',
  'Lantern Light Returns',
  'A Small Mountain',
  'Harbour Detective: The Grey Pier',
  'Harbour Detective: Night Shift',
  'Harbour Detective: Last Call',
  'Borrowed Weather',
  'The Sleeping Radio',
  'Restless Hands',
  'The Extraordinary and Mostly Accurate Account of the Night the Lighthouse Went Dark, As Told by Those Who Were There',
  'Faraway Letters',
]
const FILM_GENRES = [
  'Drama',
  'Mystery',
  'Comedy',
  'Thriller',
  'Romance',
  'Science Fiction',
  'Documentary',
  'Adventure',
  'Crime',
  'Animation',
]
const FILM_KEYWORDS = [
  'lighthouse',
  'small town',
  'heist',
  'coming of age',
  'based on novel',
  'sea voyage',
  'detective',
  'family secrets',
  'radio',
  'winter',
]
const COLLECTIONS: Record<string, string> = {
  'The Paper Lantern': 'Paper Lantern Collection',
  'The Paper Lantern II: Embers': 'Paper Lantern Collection',
  'Lantern Light Returns': 'Paper Lantern Collection',
  'Harbour Detective: The Grey Pier': 'Harbour Detective Collection',
  'Harbour Detective: Night Shift': 'Harbour Detective Collection',
  'Harbour Detective: Last Call': 'Harbour Detective Collection',
  'Northern Clockwork': 'Northern Anthology Collection',
  'Distant Engines': 'Northern Anthology Collection',
}
interface FilmSeed {
  id: string
  title: string
  released: Date
  runtime: number
  directors: string[]
  writers: string[]
  actors: string[]
  genres: string[]
  keywords: string[]
  imdbId: string
  tmdbId: number
  watched: boolean
  plan: Plan
  providers: string[]
  dateAdded: Date
}
const films: FilmSeed[] = FILM_TITLES.map((title, index) => {
  const id = `pv-film-${String(index + 1).padStart(2, '0')}`
  const year =
    1968 + Math.floor((index * 58) / FILM_TITLES.length) + between(0, 2)
  const released = new Date(
    Date.UTC(Math.min(year, 2026), between(0, 10), between(1, 28)),
  )
  // A few people work on many films.
  const director = index % 3 === 0 ? 'Anouk Brennagh' : pick(PEOPLE.directors)
  return {
    id,
    title,
    released,
    runtime: between(78, 171),
    directors: index === 5 ? [director, 'Idris Fennimore'] : [director],
    writers: [
      ...new Set([
        pick(PEOPLE.writers),
        index % 4 === 0 ? director : pick(PEOPLE.writers),
      ]),
    ],
    actors: [
      ...new Set([
        index % 2 === 0 ? 'Elodie Marchbank' : 'Kofi Ashgrove',
        ...shuffle(PEOPLE.actors).slice(0, between(2, 5)),
      ]),
    ],
    genres: shuffle(FILM_GENRES).slice(0, between(1, 3)),
    keywords: shuffle(FILM_KEYWORDS).slice(0, between(1, 4)),
    imdbId: `tt99${String(numericId(id, 100000) % 1_000_000).padStart(6, '0')}`,
    tmdbId: numericId(`${id}:tmdb`, 99_000_000),
    watched: random() < 0.55,
    plan: index < 17 ? 'scraped' : index < 21 ? 'legacy' : 'none',
    providers: [],
    dateAdded: new Date(between(NOW - 6 * 365 * DAY, NOW - 2 * DAY)),
  }
})
for (const film of films)
  film.providers =
    film.plan === 'scraped'
      ? ['omdb', 'tmdb', ...(random() < 0.7 ? ['mdblist'] : [])]
      : film.plan === 'legacy'
        ? ['omdb']
        : []

// -------------------------------------------------------- provider results

function spotifyResult(item: AlbumSeed) {
  const payload: JsonRecord = {
    id: item.spotifyId,
    name: item.spotifyTitle,
    artists: item.artists.map((name) => ({
      id: spotifyId(`artist:${name}`),
      name,
    })),
    images: [],
    release_date: isoDay(item.released),
    release_date_precision: 'day',
    total_tracks: item.tracks.length,
    external_ids: {
      upc: `00${String(numericId(item.id, 1_000_000_000)).padStart(10, '0')}`,
    },
    genres: item.tags.filter((tag) => tag !== 'seen live').slice(0, 2),
    popularity: between(4, 78),
    label: pick(LABELS),
    tracks: {
      items: item.tracks.map((track, index) => ({
        id: track.spotifyId,
        name: track.title,
        disc_number: 1,
        track_number: index + 1,
        duration_ms: track.durationSec * 1000,
        artists: item.artists.map((name) => ({ name })),
      })),
      offset: 0,
      total: item.tracks.length,
      next: null,
    },
  }
  return { payload, addedAt: item.dateAdded.toISOString() }
}
function tagsFor(item: AlbumSeed, provider: string) {
  const all = item.tags.filter(
    (tag) => tag !== 'seen live' || provider === 'lastfm',
  )
  const share = all.filter(
    (_, index) => (index + provider.length) % 2 === 0 || provider === 'lastfm',
  )
  return share.length ? share : all.slice(0, 1)
}
function albumProviderResult(
  item: AlbumSeed,
  provider: string,
  variant: number,
) {
  const slug =
    item.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'release'
  const artistSlug = (item.artists[0] ?? 'artist')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
  if (provider === 'musicbrainz') {
    const group = uuidFor(`${item.id}:release-group`)
    return PluginResultSchema.parse({
      payload: {
        releaseGroup: {
          id: group,
          title: item.title,
          'primary-type': 'Album',
          'first-release-date': isoDay(item.released),
        },
      },
      normalized: {
        mediaPatch: {
          metadata: {
            browse: {
              'plugin.musicbrainz.primaryType':
                item.tracks.length < 7 ? 'EP' : 'Album',
              ...(random() < 0.2
                ? { 'plugin.musicbrainz.secondaryTypes': ['Live'] }
                : {}),
              'plugin.musicbrainz.artistCountries': item.artists.map(
                (name) =>
                  ARTISTS.find((entry) => entry.name === name)?.country ?? 'GB',
              ),
            },
          },
        },
        references: [
          {
            referenceType: 'release-group',
            externalId: group,
            isPrimary: true,
          },
        ],
        links: [
          {
            provider: 'musicbrainz',
            label: 'MusicBrainz',
            url: `https://musicbrainz.org/release-group/${group}`,
          },
        ],
        tags: tagsFor(item, provider).map((name) => ({
          name,
          kind: 'genre',
          source: 'musicbrainz',
          rawName: name,
        })),
      },
    })
  }
  if (provider === 'discogs') {
    const master = numericId(`${item.id}:master`, 9_000_000)
    const release = numericId(`${item.id}:release`, 29_000_000)
    const have = between(40, 9000)
    const want = between(10, 2500)
    const average =
      Math.round((3.1 + random() * 1.6 - variant * 0.1) * 100) / 100
    const tags = tagsFor(item, provider)
    return PluginResultSchema.parse({
      payload: {
        id: master,
        title: item.title,
        main_release: release,
        community: { have, want, rating: { average, count: between(5, 700) } },
      },
      normalized: {
        mediaPatch: {
          metadata: {
            browse: {
              ratingDiscogsValue: average,
              ratingDiscogsVotes: between(5, 700),
              popularityDiscogs: have + want,
              'plugin.discogs.labels': [pick(LABELS)],
              'plugin.discogs.formats': [
                pick([
                  'Vinyl, LP, Album',
                  'CD, Album',
                  'File, FLAC, Album',
                  'Cassette, Album',
                ]),
              ],
              'plugin.discogs.releaseCountry': pick([
                'UK',
                'US',
                'Europe',
                'Japan',
                'Canada',
              ]),
              'plugin.discogs.have': have,
              'plugin.discogs.want': want,
              'plugin.discogs.ratingScope': `Main release ${release} only`,
            },
          },
        },
        references: [
          {
            referenceType: 'master',
            externalId: String(master),
            isPrimary: true,
          },
        ],
        links: [
          {
            provider: 'discogs',
            label: 'Discogs',
            url: `https://www.discogs.com/master/${master}`,
          },
        ],
        tags: [
          ...tags.slice(0, 2).map((name) => ({
            name,
            kind: 'genre',
            source: 'discogs',
            rawName: name,
          })),
          ...tags.slice(2).map((name) => ({
            name,
            kind: 'style',
            source: 'discogs',
            rawName: name,
          })),
        ],
      },
    })
  }
  if (provider === 'lastfm') {
    const url = `https://www.last.fm/music/${encodeURIComponent(item.artists[0] ?? '')}/${encodeURIComponent(item.title)}`
    const listeners = between(900, 480_000)
    return PluginResultSchema.parse({
      payload: {
        album: {
          name: item.title,
          artist: item.artists[0] ?? '',
          url,
          listeners,
          playcount: listeners * between(4, 12),
          userplaycount: between(0, 300),
        },
      },
      normalized: {
        mediaPatch: {
          metadata: {
            browse: {
              popularityLastFm: listeners,
              // Last.fm's own count, older than the stored scrobbles.
              scrobbles: item.scrobbled ? between(0, 300) : 0,
              'plugin.lastfm.playcount': listeners * between(4, 12),
            },
          },
        },
        references: [
          { referenceType: 'url', externalId: url, isPrimary: true },
        ],
        links: [{ provider: 'lastfm', label: 'Last.fm', url }],
        tags: tagsFor(item, provider).map((name) => ({
          name,
          kind: 'general',
          source: 'lastfm',
          rawName: name,
        })),
      },
    })
  }
  if (provider === 'serply') {
    const url = `https://rateyourmusic.com/release/album/${artistSlug}/${slug}/`
    const value = Math.round((2.7 + random() * 1.5) * 100) / 100
    const votes = between(12, 4200)
    return PluginResultSchema.parse({
      payload: {
        query: `${item.artists[0] ?? ''} ${item.title}`,
        selected: { url, rating: value, votes },
      },
      normalized: {
        mediaPatch: {
          metadata: {
            browse: { ratingRymValue: value, ratingRymVotes: votes },
          },
        },
        references: [
          { referenceType: 'rym-url', externalId: url, isPrimary: true },
        ],
        links: [{ provider: 'serply', label: 'RateYourMusic', url }],
      },
    })
  }
  throw new Error(`No album result for ${provider}`)
}

function omdbPayload(film: FilmSeed): JsonRecord {
  return {
    Title: film.title,
    Year: String(film.released.getUTCFullYear()),
    Released: film.released.toUTCString().slice(5, 16),
    Runtime: `${film.runtime} min`,
    Genre: film.genres.join(', '),
    Director: film.directors.join(', '),
    Writer: film.writers.join(', '),
    Actors: film.actors.join(', '),
    Plot: `An invented story about ${film.keywords.join(', ')}, written for the preview library.`,
    Language: pick([
      'English',
      'English, French',
      'Norwegian',
      'Portuguese, English',
    ]),
    Country: pick(['United Kingdom', 'Ireland', 'Norway', 'Canada, France']),
    imdbRating: (5.2 + random() * 3.6).toFixed(1),
    imdbVotes: between(800, 240_000).toLocaleString('en-US'),
    imdbID: film.imdbId,
    Metascore: String(between(38, 92)),
    Ratings: [{ Source: 'Rotten Tomatoes', Value: `${between(31, 99)}%` }],
    BoxOffice: `$${between(200_000, 90_000_000).toLocaleString('en-US')}`,
    Response: 'True',
  }
}
function tmdbPayload(film: FilmSeed): JsonRecord {
  // TMDb lists a regional release date and a slightly different runtime.
  const released = new Date(film.released.getTime() + between(0, 21) * DAY)
  const collection = COLLECTIONS[film.title]
  return {
    id: String(film.tmdbId),
    imdb_id: film.imdbId,
    title: film.title,
    original_title: film.title,
    overview: `Synthetic overview of ${film.title}.`,
    release_date: isoDay(released),
    runtime: film.runtime + (random() < 0.5 ? between(1, 6) : 0),
    budget: between(1, 60) * 1_000_000,
    revenue: between(0, 140) * 1_000_000,
    vote_average: Math.round((5 + random() * 3.8) * 10) / 10,
    vote_count: between(40, 18_000),
    popularity: Math.round(random() * 9000) / 100,
    genres: film.genres.map((name) => ({
      id: FILM_GENRES.indexOf(name) + 9000,
      name,
    })),
    keywords: {
      keywords: film.keywords.map((name) => ({
        id: FILM_KEYWORDS.indexOf(name) + 99000,
        name,
      })),
    },
    production_countries: [
      { name: pick(['United Kingdom', 'Norway', 'Canada']) },
    ],
    spoken_languages: [{ name: 'English' }],
    production_companies: [
      {
        name: pick([
          'Placeholder Pictures',
          'Grey Pier Films',
          'Lantern House Studios',
        ]),
      },
    ],
    credits: {
      cast: film.actors.map((name) => ({ name })),
      crew: [
        ...film.directors.map((name) => ({ name, job: 'Director' })),
        ...film.writers.map((name) => ({ name, job: 'Screenplay' })),
      ],
    },
    ...(collection
      ? {
          belongs_to_collection: {
            id: numericId(collection, 990_000),
            name: collection,
          },
        }
      : {}),
  }
}
function mdblistResult(film: FilmSeed) {
  const trakt = between(52, 88)
  const letterboxd = Math.round((2.4 + random() * 1.9) * 100) / 100
  const audience = between(40, 97)
  const metacriticUser = Math.round((4.5 + random() * 4) * 10) / 10
  return PluginResultSchema.parse({
    payload: {
      ids: { imdb: film.imdbId, tmdb: film.tmdbId },
      title: film.title,
    },
    normalized: {
      mediaPatch: {
        metadata: {
          browse: {
            ratingTrakt: trakt,
            ratingTraktVotes: between(30, 9000),
            ratingLetterboxd: letterboxd,
            ratingLetterboxdVotes: between(100, 60_000),
            ratingRtAudience: audience,
            ratingRtAudienceVotes: between(50, 25_000),
            ratingMetacriticUser: metacriticUser,
            ratingMetacriticUserVotes: between(5, 900),
          },
        },
      },
      tags: film.keywords.slice(0, 2).map((name) => ({
        name,
        kind: 'keyword',
        source: 'mdblist',
        rawName: name,
      })),
    },
  })
}

// ------------------------------------------------------------------ helpers

const TableRowsSchema = z.array(z.object({ tablename: z.string() }))
const AUTH_TABLES = new Set([
  'user',
  'session',
  'account',
  'verification',
  'apikey',
  'two_factor',
  'organization',
  'member',
  'invitation',
])

async function wipe() {
  const tables = TableRowsSchema.parse(
    (
      await db.execute(
        sql`select tablename from pg_tables where schemaname = 'public'`,
      )
    ).rows,
  )
    .map((row) => row.tablename)
    .filter(
      (name) =>
        !AUTH_TABLES.has(name) &&
        !name.startsWith('__') &&
        !name.startsWith('drizzle'),
    )
  await db.execute(
    sql.raw(
      `truncate table ${tables.map((name) => `"${name.replaceAll('"', '""')}"`).join(', ')}`,
    ),
  )
  return tables.length
}

async function credit(mediaItemId: string, names: string[], role = 'artist') {
  for (const [billingOrder, name] of names.entries()) {
    const artistId = createStableId('artist', name.toLowerCase())
    await db
      .insert(schema.artist)
      .values({ id: artistId, name, sortName: name })
      .onConflictDoNothing()
    await db
      .insert(schema.mediaCredit)
      .values({ mediaItemId, artistId, role, billingOrder })
      .onConflictDoNothing()
  }
}

// ------------------------------------------------------------------- seed

async function main() {
  const { encryptSecretValue } = await import('@/lib/crypto')
  const { albumNameKey } = await import('@/lib/album-import-candidates')
  const { normalizeOmdbPayload, normalizeTmdbPayload } =
    await import('@/lib/provider-normalizers')
  const { normalizeSpotifyAlbum } = await import('@/lib/spotify-api')
  const { applyProviderResult } = await import('@/services/provider-state')
  const { replaceAlbumTracks } = await import('@/services/album-library-tracks')
  const { patchAlbum, patchFilm } = await import('@/services/media')
  const { mergeTags, setTagVisibility } = await import('@/services/tags')
  const { relinkLastfmScrobbles } = await import('@/services/lastfm-scrobbles')
  const { observeSpotifySearchTrack, observeTidalSuggestion } =
    await import('@/services/music-catalog-observations')
  const { storeSpotifyCodeLookup } =
    await import('@/services/spotify-similar-lookup')

  const wiped = await wipe()
  console.log(`cleared ${wiped} tables`)

  // Obviously fake credentials, so providers show as configured.
  const secrets: Array<[string, string, string]> = [
    ['spotify', 'clientId', 'preview-fake-client-id'],
    ['spotify', 'clientSecret', 'preview-fake-client-secret'],
    ['musicbrainz', 'appName', 'PreviewSeed'],
    ['musicbrainz', 'appVersion', '0.0.0'],
    ['musicbrainz', 'contact', 'preview@example.invalid'],
    ['discogs', 'token', 'preview-fake-token'],
    ['lastfm', 'apiKey', 'preview-fake-api-key'],
    ['lastfm', 'username', LISTENER],
    ['serply', 'apiKey', 'preview-fake-api-key'],
    ['omdb', 'apiKey', 'preview-fake-api-key'],
    ['tmdb', 'apiKey', 'preview-fake-api-key'],
    ['mdblist', 'apiKey', 'preview-fake-api-key'],
  ]
  for (const [provider, key, value] of secrets)
    await db.insert(schema.providerSecret).values({
      id: createStableId('secret', `${provider}:${key}`),
      provider,
      key,
      encryptedValue: encryptSecretValue(value),
      lastUpdatedByUserId: USER_ID,
      lastVerifiedAt: provider === 'discogs' ? null : daysAgo(between(2, 60)),
      lastVerifiedStatus: provider === 'discogs' ? null : 'ok',
    })

  // Albums, credits and empty track lists; provider results fill the rest.
  for (const item of albums) {
    await db.insert(schema.mediaItem).values({
      id: item.id,
      slug: item.id,
      title: item.title,
      mediaType: 'album',
      artworkUrl: item.artwork,
      releaseDate: item.released,
      metadata: item.hidden ? { legacyHidden: true } : null,
      createdAt: item.dateAdded,
    })
    await db.insert(schema.album).values({
      mediaItemId: item.id,
      dateAdded: item.dateAdded,
      durationSec: item.tracks.reduce(
        (sum, track) => sum + track.durationSec,
        0,
      ),
      createdAt: item.dateAdded,
    })
    await credit(item.id, item.artists)
    if (item.plan === 'none')
      await db.transaction((tx) =>
        replaceAlbumTracks(
          tx,
          item.id,
          item.tracks.map((track, index) => ({
            title: track.title,
            position: index + 1,
            durationSec: track.durationSec,
            artists: item.artists,
          })),
        ),
      )
  }

  for (const film of films) {
    await db.insert(schema.mediaItem).values({
      id: film.id,
      slug: film.id,
      title: film.title,
      mediaType: 'film',
      artworkUrl:
        film.plan === 'none' && film.id.endsWith('3')
          ? null
          : artwork(film.id, 450),
      releaseDate: film.released,
      createdAt: film.dateAdded,
    })
    await db.insert(schema.film).values({
      mediaItemId: film.id,
      dateAdded: film.dateAdded,
      dateAddedSource: 'Library file date',
      runtimeMinutes: film.runtime,
      watched: film.watched,
      sourceKind: 'file',
      createdAt: film.dateAdded,
    })
    if (film.plan === 'none') {
      await credit(film.id, film.directors, 'director')
      await credit(film.id, film.actors, 'actor')
    }
  }

  // ----------------------------------------------------------------- jobs
  // Created before provider results so snapshots can name the job that
  // produced them.
  const jobFor = new Map<string, { id: string; at: Date }>()
  let jobCount = 0
  interface LogSpec {
    level: 'info' | 'warn' | 'error'
    message: string
    metadata?: JsonRecord
    at: Date
  }
  interface JobSpec {
    provider: string
    status: JobStatus
    mediaType: 'album' | 'film' | null
    mediaItemId?: string
    options?: JsonRecord
    createdAt: Date
    runMs?: number
    errorMessage?: string
    logs?: (job: {
      startedAt: Date | null
      finishedAt: Date | null
    }) => LogSpec[]
    itemPayload?: JsonValue
  }
  async function addJob(spec: JobSpec) {
    jobCount += 1
    const id = `pvjob${String(jobCount).padStart(4, '0')}${hash(`job${jobCount}`).slice(0, 8)}`
    const startedAt =
      spec.status === 'queued'
        ? null
        : new Date(spec.createdAt.getTime() + between(5, 90) * 1000)
    const finishedAt =
      startedAt && spec.status !== 'running'
        ? new Date(startedAt.getTime() + (spec.runMs ?? between(2, 40) * 1000))
        : null
    const title = spec.mediaItemId
      ? (albums.find((item) => item.id === spec.mediaItemId)?.title ??
        films.find((item) => item.id === spec.mediaItemId)?.title ??
        '')
      : ''
    await db.insert(schema.scrapeJob).values({
      id,
      provider: spec.provider,
      status: spec.status,
      scope: {
        mediaItemIds: spec.mediaItemId ? [spec.mediaItemId] : [],
        mediaType: spec.mediaType,
        limit: 1,
      },
      options: spec.options ?? {},
      errorMessage: spec.errorMessage ?? null,
      requestedByUserId: USER_ID,
      startedAt,
      finishedAt,
      createdAt: spec.createdAt,
      updatedAt: finishedAt ?? startedAt ?? spec.createdAt,
    })
    if (spec.mediaItemId)
      await db.insert(schema.scrapeJobItem).values({
        id: `${id}-item`,
        jobId: id,
        mediaItemId: spec.mediaItemId,
        provider: spec.provider,
        status: spec.status,
        attemptCount: spec.status === 'queued' ? 0 : 1,
        message:
          spec.status === 'succeeded'
            ? 'Completed successfully.'
            : spec.status === 'failed' || spec.status === 'cancelled'
              ? (spec.errorMessage ?? null)
              : null,
        payload: spec.itemPayload ?? {},
        startedAt,
        finishedAt,
        createdAt: spec.createdAt,
        updatedAt: finishedAt ?? startedAt ?? spec.createdAt,
      })
    const logs: LogSpec[] = [
      {
        level: 'info',
        message: spec.mediaItemId
          ? `Queued ${spec.provider} job for 1 item`
          : `Queued ${String(spec.options?.task ?? spec.provider)}`,
        at: spec.createdAt,
      },
      ...(startedAt && spec.mediaItemId
        ? [
            {
              level: 'info' as const,
              message: `Started ${title}`,
              metadata: { mediaItemId: spec.mediaItemId },
              at: startedAt,
            },
          ]
        : []),
      ...(spec.logs?.({ startedAt, finishedAt }) ?? []),
    ]
    if (spec.status === 'succeeded' && spec.mediaItemId && finishedAt)
      logs.push({
        level: 'info',
        message: `Completed ${title}`,
        metadata: { mediaItemId: spec.mediaItemId },
        at: finishedAt,
      })
    for (const [index, log] of logs.entries())
      await db.insert(schema.scrapeJobLog).values({
        id: `${id}-log${index}`,
        jobId: id,
        level: log.level,
        message: log.message,
        metadata: log.metadata ?? {},
        createdAt: log.at,
      })
    if (spec.mediaItemId && spec.status === 'succeeded' && finishedAt)
      jobFor.set(`${spec.mediaItemId}:${spec.provider}`, { id, at: finishedAt })
    return { id, startedAt, finishedAt }
  }
  const requestLog = (
    provider: string,
    path: string,
    status: number,
    time: Date | null,
  ): LogSpec[] =>
    time
      ? [
          {
            level: 'info',
            message: `Request ${status === 200 ? 'completed' : 'returned'} HTTP ${status}`,
            metadata: {
              diagnostics: [
                {
                  stage: 'request',
                  evidence: { method: 'GET', url: `${path}`, provider },
                },
                {
                  stage: 'response',
                  evidence: {
                    status,
                    durationMs: between(120, 1900),
                    contentType: 'application/json',
                    bytes: between(900, 48_000),
                  },
                },
              ],
            },
            at: new Date(time.getTime() - 1000),
          },
        ]
      : []
  const failure = (
    message: string,
    options: {
      code?: 'rate-limit' | 'cooldown' | 'request-failed' | 'access-denied'
      retryAt?: number
      classification?: 'not-found' | 'ambiguous'
      status?: number
      mediaItemId?: string
    },
  ): JsonRecord => ({
    ...(options.mediaItemId ? { mediaItemId: options.mediaItemId } : {}),
    error: {
      name: options.code
        ? 'ProviderRequestError'
        : options.classification === 'not-found'
          ? 'ProviderItemNotFoundError'
          : 'Error',
      message,
      stack: null,
      ...(options.code ? { code: options.code } : {}),
      ...(options.retryAt ? { retryAt: options.retryAt } : {}),
      causes: [],
    },
    ...(options.status
      ? {
          diagnostics: [
            {
              stage: 'response',
              evidence: {
                status: options.status,
                durationMs: between(80, 3000),
              },
            },
          ],
        }
      : {}),
    ...(options.classification
      ? { classification: options.classification }
      : {}),
  })

  const scraped = shuffle(albums.filter((item) => item.plan === 'scraped'))
  // Batch of 40 MusicBrainz album jobs, started three hours ago and halted by
  // the current cooldown: 22 succeeded, 2 failed, 16 queued.
  const cooldownUntil = NOW + 40 * MINUTE
  const batchStart = NOW - 3 * HOUR
  for (const [index, item] of scraped.slice(0, 40).entries()) {
    if (index < 22 && !item.providers.includes('musicbrainz'))
      item.providers.push('musicbrainz')
    const status: JobStatus =
      index < 22 ? 'succeeded' : index < 24 ? 'failed' : 'queued'
    const code = index === 22 ? 'rate-limit' : 'cooldown'
    await addJob({
      provider: 'musicbrainz',
      status,
      mediaType: 'album',
      mediaItemId: item.id,
      options: { batchId: 'pv-batch-musicbrainz-refresh' },
      createdAt: new Date(batchStart + index * 1000),
      runMs: status === 'succeeded' ? (index + 1) * 5 * MINUTE : 4000,
      errorMessage:
        status === 'failed'
          ? code === 'rate-limit'
            ? 'ProviderRequestError: MusicBrainz rate limited the request (HTTP 503)'
            : 'ProviderRequestError: MusicBrainz is cooling down'
          : undefined,
      itemPayload:
        status === 'succeeded'
          ? {
              releaseGroup: {
                id: uuidFor(`${item.id}:release-group`),
                title: item.title,
              },
            }
          : undefined,
      logs: ({ finishedAt }) =>
        status === 'succeeded'
          ? requestLog(
              'musicbrainz',
              `https://musicbrainz.org/ws/2/release-group/${uuidFor(`${item.id}:release-group`)}?inc=artists+tags+genres+url-rels&fmt=json`,
              200,
              finishedAt,
            )
          : status === 'failed' && finishedAt
            ? [
                {
                  level: 'warn',
                  message:
                    'Retrying request (attempt 1) after ProviderRequestError: HTTP 503',
                  metadata: {
                    mediaItemId: item.id,
                    attempt: 1,
                    retryAt: new Date(
                      finishedAt.getTime() - 2000,
                    ).toISOString(),
                  },
                  at: new Date(finishedAt.getTime() - 3000),
                },
                {
                  level: 'error',
                  message:
                    code === 'rate-limit'
                      ? 'ProviderRequestError: MusicBrainz rate limited the request (HTTP 503)'
                      : 'ProviderRequestError: MusicBrainz is cooling down',
                  metadata: failure(
                    code === 'rate-limit'
                      ? 'MusicBrainz rate limited the request (HTTP 503)'
                      : 'MusicBrainz is cooling down',
                    {
                      code,
                      retryAt: cooldownUntil,
                      status: 503,
                      mediaItemId: item.id,
                    },
                  ),
                  at: finishedAt,
                },
                {
                  level: 'warn',
                  message:
                    'Provider dispatch paused after errors or cooldown. No automatic retry scheduled.',
                  at: finishedAt,
                },
              ]
            : [],
    })
  }
  // Finished batch of 12 Discogs jobs, nine days ago.
  for (const [index, item] of shuffle(scraped).slice(0, 12).entries()) {
    if (!item.providers.includes('discogs')) item.providers.push('discogs')
    const master = numericId(`${item.id}:master`, 9_000_000)
    await addJob({
      provider: 'discogs',
      status: 'succeeded',
      mediaType: 'album',
      mediaItemId: item.id,
      options: { batchId: 'pv-batch-discogs-ratings' },
      createdAt: new Date(NOW - 9 * DAY + index * 1000),
      runMs: (index + 1) * 90_000,
      itemPayload: { id: master, title: item.title },
      logs: ({ finishedAt }) =>
        requestLog(
          'discogs',
          `https://api.discogs.com/masters/${master}`,
          200,
          finishedAt,
        ),
    })
  }
  // A library import that queued eight Spotify album jobs, twenty days ago.
  const importAlbums = shuffle(
    albums.filter((item) => item.plan !== 'none' && !item.hidden),
  ).slice(0, 8)
  for (const [index, item] of importAlbums.entries())
    await addJob({
      provider: 'spotify',
      status: 'succeeded',
      mediaType: 'album',
      mediaItemId: item.id,
      options: { batchId: 'pv-batch-library-import' },
      createdAt: new Date(NOW - 20 * DAY + index * 1000),
      runMs: (index + 1) * 20_000,
      itemPayload: { id: item.spotifyId, name: item.spotifyTitle },
      logs: ({ finishedAt }) =>
        requestLog(
          'spotify',
          `https://api.spotify.com/v1/albums/${item.spotifyId}`,
          200,
          finishedAt,
        ),
    })
  await db.insert(schema.libraryImport).values({
    id: 'pv-library-import',
    status: 'succeeded',
    stage: 'complete',
    processed: 8,
    total: 8,
    result: {
      albums: 8,
      films: 0,
      mediaType: 'album',
      skipped: 0,
      failed: 0,
      warnings: [],
      jobBatchId: 'pv-batch-library-import',
      queuedJobs: 8,
      skippedJobs: 0,
    },
    requestedByUserId: USER_ID,
    createdAt: daysAgo(20),
    finishedAt: new Date(NOW - 20 * DAY + 4 * MINUTE),
  })

  // Single album jobs in every status, with stored error codes and classifications.
  const single = shuffle(scraped).slice(0, 16)
  const [s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12] = single
  if (
    !s0 ||
    !s1 ||
    !s2 ||
    !s3 ||
    !s4 ||
    !s5 ||
    !s6 ||
    !s7 ||
    !s8 ||
    !s9 ||
    !s10 ||
    !s11 ||
    !s12
  )
    throw new Error('Not enough scraped albums')
  await addJob({
    provider: 'serply',
    status: 'failed',
    mediaType: 'album',
    mediaItemId: s0.id,
    createdAt: daysAgo(2),
    errorMessage: 'Several RateYourMusic pages match this album',
    logs: ({ finishedAt }) =>
      finishedAt
        ? [
            {
              level: 'error',
              message: 'Error: Several RateYourMusic pages match this album',
              metadata: {
                ...failure('Several RateYourMusic pages match this album', {
                  classification: 'ambiguous',
                  mediaItemId: s0.id,
                }),
                diagnostics: [
                  {
                    stage: 'search.candidates',
                    evidence: {
                      total: 3,
                      candidates: [
                        `${s0.title}`,
                        `${s0.title} (Deluxe)`,
                        `${s0.title} (Live)`,
                      ],
                    },
                  },
                ],
              },
              at: finishedAt,
            },
          ]
        : [],
  })
  await addJob({
    provider: 'serply',
    status: 'running',
    mediaType: 'album',
    mediaItemId: s1.id,
    createdAt: at(6 * MINUTE),
  })
  await addJob({
    provider: 'lastfm',
    status: 'failed',
    mediaType: 'album',
    mediaItemId: s2.id,
    createdAt: daysAgo(4),
    errorMessage: 'Album not found',
    logs: ({ finishedAt }) =>
      finishedAt
        ? [
            {
              level: 'error',
              message: 'ProviderItemNotFoundError: Album not found',
              metadata: failure('Album not found', {
                classification: 'not-found',
                status: 404,
                mediaItemId: s2.id,
              }),
              at: finishedAt,
            },
          ]
        : [],
  })
  for (const item of [s3, s4]) {
    if (!item.providers.includes('lastfm')) item.providers.push('lastfm')
    await addJob({
      provider: 'lastfm',
      status: 'succeeded',
      mediaType: 'album',
      mediaItemId: item.id,
      createdAt: at(between(2, 30) * HOUR),
      itemPayload: { album: { name: item.title } },
      logs: ({ finishedAt }) =>
        requestLog(
          'lastfm',
          'https://ws.audioscrobbler.com/2.0/?method=album.getinfo',
          200,
          finishedAt,
        ),
    })
  }
  await addJob({
    provider: 'lastfm',
    status: 'queued',
    mediaType: 'album',
    mediaItemId: s5.id,
    createdAt: at(20 * MINUTE),
  })
  const haltedAt = NOW - 6 * HOUR
  await addJob({
    provider: 'discogs',
    status: 'failed',
    mediaType: 'album',
    mediaItemId: s6.id,
    createdAt: new Date(haltedAt - 30_000),
    errorMessage: 'ProviderRequestError: Discogs denied access (HTTP 401)',
    logs: ({ finishedAt }) =>
      finishedAt
        ? [
            {
              level: 'error',
              message: 'ProviderRequestError: Discogs denied access (HTTP 401)',
              metadata: failure('Discogs denied access (HTTP 401)', {
                code: 'access-denied',
                status: 401,
                mediaItemId: s6.id,
              }),
              at: finishedAt,
            },
          ]
        : [],
  })
  for (const item of [s7, s8])
    await addJob({
      provider: 'discogs',
      status: 'queued',
      mediaType: 'album',
      mediaItemId: item.id,
      createdAt: new Date(haltedAt - 20_000),
    })
  await addJob({
    provider: 'musicbrainz',
    status: 'failed',
    mediaType: 'album',
    mediaItemId: s9.id,
    createdAt: daysAgo(1),
    errorMessage: 'ProviderRequestError: MusicBrainz request failed (HTTP 502)',
    logs: ({ finishedAt }) =>
      finishedAt
        ? [
            {
              level: 'error',
              message:
                'ProviderRequestError: MusicBrainz request failed (HTTP 502)',
              metadata: failure('MusicBrainz request failed (HTTP 502)', {
                code: 'request-failed',
                status: 502,
                mediaItemId: s9.id,
              }),
              at: finishedAt,
            },
          ]
        : [],
  })
  for (const item of [s10, s11])
    await addJob({
      provider: 'spotify',
      status: 'succeeded',
      mediaType: 'album',
      mediaItemId: item.id,
      createdAt: at(between(1, 9) * DAY),
      itemPayload: { id: item.spotifyId, name: item.spotifyTitle },
      logs: ({ finishedAt }) =>
        requestLog(
          'spotify',
          `https://api.spotify.com/v1/albums/${item.spotifyId}`,
          200,
          finishedAt,
        ),
    })
  await addJob({
    provider: 'spotify',
    status: 'cancelled',
    mediaType: 'album',
    mediaItemId: s12.id,
    createdAt: daysAgo(3),
    errorMessage: 'Cancelled by user',
  })

  // Film jobs.
  const scrapedFilms = films.filter((film) => film.plan === 'scraped')
  const filmJob = async (
    provider: string,
    status: JobStatus,
    film: FilmSeed | undefined,
    ago: number,
    extra: Partial<JobSpec> = {},
  ) => {
    if (!film) throw new Error('Missing film')
    return addJob({
      provider,
      status,
      mediaType: 'film',
      mediaItemId: film.id,
      createdAt: at(ago),
      ...(status === 'succeeded'
        ? {
            itemPayload: { title: film.title, imdbID: film.imdbId },
            logs: ({ finishedAt }) =>
              requestLog(
                provider,
                provider === 'omdb'
                  ? `https://www.omdbapi.com/?i=${film.imdbId}`
                  : provider === 'tmdb'
                    ? `https://api.themoviedb.org/3/movie/${film.tmdbId}`
                    : `https://api.mdblist.com/imdb/movie/${film.imdbId}/`,
                200,
                finishedAt,
              ),
          }
        : {}),
      ...extra,
    })
  }
  for (const [index, film] of scrapedFilms.slice(0, 3).entries())
    await filmJob('omdb', 'succeeded', film, (index + 1) * 5 * HOUR)
  await filmJob('omdb', 'failed', scrapedFilms[3], 30 * HOUR, {
    errorMessage: 'ProviderRequestError: OMDb request failed (HTTP 500)',
    logs: ({ finishedAt }) =>
      finishedAt
        ? [
            {
              level: 'error',
              message: 'ProviderRequestError: OMDb request failed (HTTP 500)',
              metadata: failure('OMDb request failed (HTTP 500)', {
                code: 'request-failed',
                status: 500,
              }),
              at: finishedAt,
            },
          ]
        : [],
  })
  for (const [index, film] of scrapedFilms.slice(4, 6).entries())
    await filmJob('tmdb', 'succeeded', film, (index + 2) * DAY)
  await filmJob('tmdb', 'failed', films[21], 3 * DAY, {
    errorMessage: 'Movie not found',
    logs: ({ finishedAt }) =>
      finishedAt
        ? [
            {
              level: 'error',
              message: 'ProviderItemNotFoundError: Movie not found',
              metadata: failure('Movie not found', {
                classification: 'not-found',
                status: 404,
              }),
              at: finishedAt,
            },
          ]
        : [],
  })
  await filmJob('tmdb', 'cancelled', scrapedFilms[6], 5 * DAY, {
    errorMessage: 'Cancelled by user',
  })
  for (const film of scrapedFilms.slice(7, 9))
    if (!film.providers.includes('mdblist')) film.providers.push('mdblist')
  for (const [index, film] of scrapedFilms.slice(7, 9).entries())
    await filmJob('mdblist', 'succeeded', film, (index + 1) * 3 * HOUR)
  for (const film of scrapedFilms.slice(9, 11))
    await filmJob('mdblist', 'queued', film, 15 * MINUTE)

  // Task jobs: account, Last.fm, subscription and artist work.
  await addJob({
    provider: 'spotify',
    status: 'running',
    mediaType: 'album',
    createdAt: at(4 * MINUTE),
    options: {
      task: 'spotify-playlist-import',
      groupKey: `spotify:${spotifyId('playlist:commute')}`,
      spotifyId: spotifyId('playlist:commute'),
      name: 'Morning Commute',
      userId: USER_ID,
      progress: { pagesRead: 2, totalPages: 5 },
    },
    logs: ({ startedAt }) =>
      startedAt
        ? [
            {
              level: 'info',
              message: 'Read page 2 of 5',
              at: new Date(startedAt.getTime() + 40_000),
            },
          ]
        : [],
  })
  await addJob({
    provider: 'spotify',
    status: 'succeeded',
    mediaType: 'album',
    createdAt: daysAgo(1),
    options: {
      task: 'spotify-playlist-listing',
      userId: USER_ID,
      progress: { pagesRead: 2, totalPages: 2 },
    },
    logs: ({ finishedAt }) =>
      finishedAt
        ? [{ level: 'info', message: 'Listed 5 playlists', at: finishedAt }]
        : [],
  })
  await addJob({
    provider: 'lastfm',
    status: 'succeeded',
    mediaType: 'album',
    createdAt: at(2 * HOUR + 5 * MINUTE),
    runMs: 5 * MINUTE,
    options: {
      task: 'lastfm-scrobble-sync',
      groupKey: 'lastfm-scrobble-sync',
      progress: { pagesRead: 1, totalPages: 1 },
    },
    logs: ({ finishedAt }) =>
      finishedAt
        ? [
            {
              level: 'info',
              message: 'Stored 42 new scrobbles',
              at: finishedAt,
            },
          ]
        : [],
  })
  await addJob({
    provider: 'lastfm',
    status: 'failed',
    mediaType: 'album',
    createdAt: daysAgo(3),
    options: {
      task: 'lastfm-scrobble-sync',
      groupKey: 'lastfm-scrobble-sync',
      progress: { pagesRead: 31, totalPages: 76 },
    },
    errorMessage:
      'ProviderRequestError: Last.fm rate limited the request (error 29)',
    logs: ({ finishedAt }) =>
      finishedAt
        ? [
            {
              level: 'error',
              message:
                'ProviderRequestError: Last.fm rate limited the request (error 29)',
              metadata: failure('Last.fm rate limited the request (error 29)', {
                code: 'rate-limit',
                status: 429,
              }),
              at: finishedAt,
            },
          ]
        : [],
  })
  await addJob({
    provider: 'youtube',
    status: 'succeeded',
    mediaType: null,
    createdAt: daysAgo(1),
    runMs: 3 * MINUTE,
    options: {
      task: 'youtube-subscription-sync',
      userId: USER_ID,
      progress: { pagesRead: 6, totalPages: 6 },
    },
    logs: ({ finishedAt }) =>
      finishedAt
        ? [
            {
              level: 'info',
              message: 'Stored 12 new videos from 3 channels',
              at: finishedAt,
            },
          ]
        : [],
  })
  await addJob({
    provider: 'youtube',
    status: 'cancelled',
    mediaType: null,
    createdAt: daysAgo(8),
    options: { task: 'youtube-subscription-sync', userId: USER_ID },
    errorMessage: 'Cancelled by user',
  })
  await addJob({
    provider: 'spotify',
    status: 'failed',
    mediaType: null,
    createdAt: daysAgo(2),
    options: {
      task: 'spotify-podcast-sync',
      userId: USER_ID,
      progress: { pagesRead: 1, totalPages: null },
    },
    errorMessage: 'ProviderRequestError: Spotify request failed (HTTP 502)',
    logs: ({ finishedAt }) =>
      finishedAt
        ? [
            {
              level: 'error',
              message:
                'ProviderRequestError: Spotify request failed (HTTP 502)',
              metadata: failure('Spotify request failed (HTTP 502)', {
                code: 'request-failed',
                status: 502,
              }),
              at: finishedAt,
            },
          ]
        : [],
  })

  // Artist profiles for half the artists, with the enrichment jobs that wrote them.
  const profileArtists = ARTISTS.filter((_, index) => index % 2 === 0)
  const artistJobs = new Map<string, string>()
  for (const [index, entry] of profileArtists.entries()) {
    const artistId = createStableId('artist', entry.name.toLowerCase())
    const provider = pick(
      ['musicbrainz', 'lastfm', 'spotify', 'discogs'],
      index,
    )
    const job = await addJob({
      provider,
      status: 'succeeded',
      mediaType: null,
      createdAt: daysAgo(between(1, 40)),
      options: {
        task: 'artist-enrichment',
        artistId,
        artistName: entry.name,
        provider,
        groupKey: artistId,
        progress: { pagesRead: 1, totalPages: 1 },
      },
      logs: ({ finishedAt }) =>
        finishedAt
          ? [
              {
                level: 'info',
                message: 'Artist profile saved.',
                at: finishedAt,
              },
            ]
          : [],
    })
    artistJobs.set(`${artistId}:${provider}`, job.id)
  }
  const [a1, a2, a3] = ARTISTS.filter((_, index) => index % 2 === 1)
  if (!a1 || !a2 || !a3) throw new Error('Missing artists')
  const artistTask = (entry: { name: string }, provider: string) => {
    const artistId = createStableId('artist', entry.name.toLowerCase())
    return {
      task: 'artist-enrichment',
      artistId,
      artistName: entry.name,
      provider,
      groupKey: artistId,
    }
  }
  await addJob({
    provider: 'discogs',
    status: 'failed',
    mediaType: null,
    createdAt: daysAgo(6),
    options: artistTask(a1, 'discogs'),
    errorMessage: 'Several Discogs artists match this name',
    logs: ({ finishedAt }) =>
      finishedAt
        ? [
            {
              level: 'error',
              message: 'Error: Several Discogs artists match this name',
              metadata: {
                ...failure('Several Discogs artists match this name', {
                  classification: 'ambiguous',
                }),
                diagnostics: [
                  { stage: 'artist.stored-candidates', evidence: { total: 2 } },
                ],
              },
              at: finishedAt,
            },
          ]
        : [],
  })
  await addJob({
    provider: 'musicbrainz',
    status: 'failed',
    mediaType: null,
    createdAt: daysAgo(5),
    options: artistTask(a2, 'musicbrainz'),
    errorMessage: 'Artist not found',
    logs: ({ finishedAt }) =>
      finishedAt
        ? [
            {
              level: 'error',
              message: 'ProviderItemNotFoundError: Artist not found',
              metadata: failure('Artist not found', {
                classification: 'not-found',
                status: 404,
              }),
              at: finishedAt,
            },
          ]
        : [],
  })
  await addJob({
    provider: 'lastfm',
    status: 'queued',
    mediaType: null,
    createdAt: at(10 * MINUTE),
    options: artistTask(a3, 'lastfm'),
  })

  // ------------------------------------------------- provider results: albums
  async function apply(
    mediaItemId: string,
    mediaType: 'album' | 'film',
    provider: string,
    result: {
      payload: JsonValue
      normalized: Parameters<typeof applyProviderResult>[0]['normalized']
    },
    source: 'scrape-job' | 'legacy-import',
    when: Date,
  ) {
    const job =
      source === 'scrape-job'
        ? jobFor.get(`${mediaItemId}:${provider}`)
        : undefined
    const time = job?.at ?? when
    await applyProviderResult({
      mediaItemId,
      mediaType,
      provider,
      source,
      payload: result.payload,
      normalized: result.normalized,
      scrapeJobId: job?.id ?? null,
    })
    const [state] = await db
      .select()
      .from(schema.providerCurrentState)
      .where(
        and(
          eq(schema.providerCurrentState.mediaItemId, mediaItemId),
          eq(schema.providerCurrentState.provider, provider),
        ),
      )
    if (!state) throw new Error('Provider state missing')
    if (state.latestSnapshotId)
      await db
        .update(schema.providerSnapshot)
        .set({ createdAt: time })
        .where(eq(schema.providerSnapshot.id, state.latestSnapshotId))
    await db
      .update(schema.providerCurrentState)
      .set({
        lastSuccessfulAt: time,
        lastScrapedAt: source === 'scrape-job' ? time : null,
        createdAt: time,
        updatedAt: time,
      })
      .where(eq(schema.providerCurrentState.id, state.id))
  }
  const scrapeTime = () => {
    // Spread from yesterday to 400 days ago, weighted towards recent.
    const days = Math.round(1 + 399 * random() ** 2)
    return new Date(NOW - days * DAY - between(0, 20) * HOUR)
  }

  // A small imported ratings cohort for the paired-source charts. Later
  // snapshots below replace the imported values for sources actually scraped.
  const ratedAlbums = albums
    .filter((item) => item.plan === 'scraped' && !item.hidden)
    .slice(0, 24)
  for (const [index, item] of ratedAlbums.entries()) {
    const browse = {
      ratingRymValue: (240 + ((index * 19) % 205)) / 100,
      ratingRymVotes: 40 + index * 12,
      ratingDiscogsValue: (225 + ((index * 13) % 240)) / 100,
      ratingDiscogsVotes: 17 + index * 5,
      ratingMetacriticValue: 31 + ((index * 7) % 65),
      ratingMetacriticVotes: 10 + ((index * 3) % 28),
    }
    await apply(
      item.id,
      'album',
      'legacy-record',
      PluginResultSchema.parse({
        payload: { title: item.title, ...browse },
        normalized: { mediaPatch: { metadata: { browse } } },
      }),
      'legacy-import',
      daysAgo(450),
    )
  }

  for (const item of albums) {
    if (item.plan === 'none') continue
    const source = item.plan === 'scraped' ? 'scrape-job' : 'legacy-import'
    for (const provider of item.providers) {
      // Some items have an older snapshot from the same provider.
      const history = source === 'scrape-job' && random() < 0.25
      const latest = scrapeTime()
      const times = history
        ? [new Date(latest.getTime() - between(30, 300) * DAY), latest]
        : [latest]
      for (const [variant, time] of times.entries()) {
        const result =
          provider === 'spotify'
            ? (() => {
                const { payload, addedAt } = spotifyResult(item)
                return normalizeSpotifyAlbum(payload, addedAt)
              })()
            : albumProviderResult(item, provider, times.length - 1 - variant)
        if (provider === 'spotify') {
          const tags = tagsFor(item, provider)
          result.normalized.tags = tags.map((name) => ({ name, kind: 'genre' }))
        }
        await apply(item.id, 'album', provider, result, source, time)
      }
    }
  }
  // A manual title over Spotify's remaster title.
  await patchAlbum(
    harbour.id,
    { title: 'Harbour Lights', note: 'Spotify lists the remaster title' },
    USER_ID,
  )
  console.log('albums:', albums.length)

  // -------------------------------------------------- provider results: films
  for (const [index, film] of films.entries()) {
    if (film.watched && film.plan !== 'none') {
      const rating = 1 + ((index * 3) % 10)
      const payload = {
        Title: film.title,
        Const: film.imdbId,
        'Your Rating': String(rating),
      }
      await apply(
        film.id,
        'film',
        'imdb-ratings',
        PluginResultSchema.parse({
          payload,
          normalized: {
            mediaPatch: {
              metadata: { browse: { ratingImdbPersonal: rating } },
            },
          },
        }),
        'legacy-import',
        daysAgo(450),
      )
    }
    const source = film.plan === 'scraped' ? 'scrape-job' : 'legacy-import'
    for (const provider of film.providers) {
      const result =
        provider === 'omdb'
          ? normalizeOmdbPayload(omdbPayload(film))
          : provider === 'tmdb'
            ? normalizeTmdbPayload(tmdbPayload(film))
            : mdblistResult(film)
      await apply(film.id, 'film', provider, result, source, scrapeTime())
    }
  }
  const overrideFilm = films[2]
  if (!overrideFilm) throw new Error('Missing film')
  await patchFilm(
    overrideFilm.id,
    { runtimeMinutes: overrideFilm.runtime + 14, note: 'Extended cut on disc' },
    USER_ID,
  )
  console.log('films:', films.length)

  // Tag merge and a hidden tag.
  const albumTag = async (name: string) => {
    const [row] = await db
      .select({ id: schema.tag.id })
      .from(schema.tag)
      .where(and(eq(schema.tag.mediaType, 'album'), eq(schema.tag.name, name)))
    if (!row) throw new Error(`Missing tag ${name}`)
    return row.id
  }
  await mergeTags(
    {
      mediaType: 'album',
      sourceIds: [await albumTag('synth pop')],
      targetId: await albumTag('synthpop'),
    },
    USER_ID,
  )
  await setTagVisibility({
    mediaType: 'album',
    tagIds: [await albumTag('seen live')],
    hidden: true,
  })

  // ------------------------------------------------------- artist profiles
  for (const [index, entry] of profileArtists.entries()) {
    const artistId = createStableId('artist', entry.name.toLowerCase())
    const providers = ['musicbrainz', 'lastfm', 'spotify', 'discogs'].slice(
      0,
      1 + (index % 3),
    )
    const own = pick(['musicbrainz', 'lastfm', 'spotify', 'discogs'], index)
    if (!providers.includes(own)) providers.push(own)
    for (const provider of providers) {
      const externalId =
        provider === 'musicbrainz'
          ? uuidFor(`artist:${entry.name}`)
          : provider === 'spotify'
            ? spotifyId(`artist:${entry.name}`)
            : provider === 'discogs'
              ? String(numericId(`artist:${entry.name}`, 8_000_000))
              : entry.name
      const url =
        provider === 'musicbrainz'
          ? `https://musicbrainz.org/artist/${externalId}`
          : provider === 'spotify'
            ? `https://open.spotify.com/artist/${externalId}`
            : provider === 'discogs'
              ? `https://www.discogs.com/artist/${externalId}`
              : `https://www.last.fm/music/${encodeURIComponent(entry.name)}`
      const profile = ArtistProfileSchema.parse({
        name: entry.name,
        summary: `${entry.name} is an invented ${entry.type === 'Group' ? 'group' : 'musician'} in the preview library, active since ${entry.from}.`,
        country: entry.country,
        type: entry.type,
        externalId,
        url,
        tags: shuffle(TAGS).slice(0, between(2, 5)),
      })
      const snapshotId = createStableId(
        'artist-snapshot',
        `${artistId}:${provider}`,
      )
      const jobId = artistJobs.get(`${artistId}:${provider}`) ?? null
      await db.insert(schema.artistProviderSnapshot).values({
        id: snapshotId,
        artistId,
        provider: z
          .enum(['spotify', 'lastfm', 'discogs', 'musicbrainz'])
          .parse(provider),
        payload: { name: entry.name, id: externalId },
        normalizedData: profile,
        scrapeJobId: jobId,
        createdAt: daysAgo(between(1, 120)),
      })
      await db.insert(schema.artistProviderCurrentState).values({
        artistId,
        provider: z
          .enum(['spotify', 'lastfm', 'discogs', 'musicbrainz'])
          .parse(provider),
        latestSnapshotId: snapshotId,
      })
    }
  }

  // ----------------------------------------------- standalone playlist tracks
  const standalone: Array<{
    id: string
    title: string
    artist: string
    albumName: string
    spotifyId: string
    durationSec: number
  }> = []
  for (let index = 0; index < 28; index += 1) {
    const outside = pick(OUTSIDE, index)
    const title = `${pick(TRACK_A, index * 3)} ${pick(TRACK_B, index * 5 + 1)}${index > 15 ? ' (Edit)' : ''}`
    const trackId = spotifyId(`standalone:${index}`)
    standalone.push({
      id: createStableId('track', `spotify:${trackId}`),
      title,
      artist: outside.artist,
      albumName: outside.album ?? `${title} (Single)`,
      spotifyId: trackId,
      durationSec: between(140, 330),
    })
  }
  for (const track of standalone) {
    const added = daysAgo(between(10, 900))
    await db.insert(schema.mediaItem).values({
      id: track.id,
      slug: track.id,
      mediaType: 'track',
      title: track.title,
      sourceLabel: 'spotify',
      artworkUrl: artwork(track.albumName),
      createdAt: added,
    })
    await db.insert(schema.libraryTrack).values({
      mediaItemId: track.id,
      spotifyTrackId: track.spotifyId,
      durationSec: track.durationSec,
      spotifyUrl: `https://open.spotify.com/track/${track.spotifyId}`,
      albumName: track.albumName,
      spotifyAlbumId: spotifyId(`standalone-album:${track.albumName}`),
      dateAdded: added,
      createdAt: added,
    })
    await credit(track.id, [track.artist])
  }

  // Saved Similar reads, including one Spotify match and one shadow track.
  const similarKinds: ('album' | 'track')[] = ['album', 'track']
  for (const kind of similarKinds) {
    const album = kind === 'album'
    const parent = album ? albums[0] : standalone[2]
    if (!parent) continue
    const tidalId = album ? '930010' : '930020'
    const title = album ? 'Evening Transmissions' : 'Tidal Basin Edit'
    const artists = ['Halden Row']
    const code = album ? '9123456789012' : null
    await db.insert(schema.providerReference).values({
      id: `pv-similar-${kind}`,
      mediaItemId: parent.id,
      provider: 'tidal',
      referenceType: kind,
      externalId: album ? '930001' : '930002',
    })
    const suggestion: TidalSuggestion = {
      tidalId,
      title,
      artists,
      code,
      version: null,
      url: `https://tidal.com/browse/${kind}/${tidalId}`,
      durationSec: album ? null : 263,
      releaseDate: album ? '2025-10-04' : null,
      genres: album ? [] : ['Deep House'],
    }
    if (!album) {
      const artistCredits = [{ id: '930022', name: 'Halden Row' }]
      suggestion.artistCredits = artistCredits
      suggestion.linkedAlbums = [
        {
          id: '930021',
          title: 'Harbour Current',
          releaseDate: null,
          artistCredits,
        },
      ]
      suggestion.catalogMediaItemId = await db.transaction((tx) =>
        observeTidalSuggestion(tx, 'track', suggestion, {
          operation: 'similar',
          key: parent.id,
          subjectKind: 'track',
          subjectId: parent.id,
          position: 1,
        }),
      )
    }
    await db.insert(schema.tidalSimilar).values({
      mediaItemId: parent.id,
      kind,
      readAt: daysAgo(1),
      items: [suggestion],
    })
    if (code) {
      const id = spotifyId('similar-album')
      await db.insert(schema.spotifyCodeLookup).values({
        codeType: 'upc',
        code,
        spotifyId: id,
        searchedAt: daysAgo(1),
        result: {
          spotifyId: id,
          url: `https://open.spotify.com/album/${id}`,
          title,
          artists,
          albumName: null,
          spotifyAlbumId: null,
          artworkUrl: null,
          durationSec: null,
          trackCount: 8,
          genres: ['Ambient', 'Dub'],
        },
      })
    }
  }

  // A recommendation with corroborating TIDAL and Spotify recording credits.
  // The artist has a native Spotify identity but has never had a profile scrape.
  const similarTrack = standalone[2]
  if (similarTrack) {
    const name = 'Glass Meridian'
    const tidalId = '930023'
    const code = 'QZFX22600003'
    const title = 'Northbound Echo'
    const durationSec = 228
    const spotifyTrackId = spotifyId(`track:${title}`)
    const match = {
      spotifyId: spotifyTrackId,
      url: `https://open.spotify.com/track/${spotifyTrackId}`,
      title,
      artists: [name],
      artistCredits: [{ id: spotifyId(`artist:${name}`), name }],
      durationSec,
      albumName: null,
      spotifyAlbumId: null,
      artworkUrl: null,
      trackCount: null,
    }
    const suggestion: TidalSuggestion = {
      tidalId,
      title,
      artists: [name],
      artistCredits: [{ id: '930024', name }],
      code,
      url: `https://tidal.com/browse/track/${tidalId}`,
      durationSec,
      version: null,
      releaseDate: null,
    }
    const { id: jobId } = await addJob({
      provider: 'spotify',
      status: 'succeeded',
      mediaType: null,
      createdAt: daysAgo(1),
    })
    const savedLocation = and(
      eq(schema.tidalSimilar.mediaItemId, similarTrack.id),
      eq(schema.tidalSimilar.kind, 'track'),
    )
    await db.transaction(async (tx) => {
      const catalogMediaItemId = await observeTidalSuggestion(
        tx,
        'track',
        suggestion,
        {
          subjectKind: 'track',
          subjectId: similarTrack.id,
          operation: 'similar',
          key: similarTrack.id,
          position: 2,
        },
      )
      const [saved] = await tx
        .select({ items: schema.tidalSimilar.items })
        .from(schema.tidalSimilar)
        .where(savedLocation)
      if (!saved) throw new Error('Missing saved Similar preview')
      const items = z.array(TidalSuggestionSchema).parse(saved.items)
      await tx
        .update(schema.tidalSimilar)
        .set({ items: [...items, { ...suggestion, catalogMediaItemId }] })
        .where(savedLocation)
      await observeSpotifySearchTrack(
        tx,
        {
          ...match,
          spotifyTrackId,
          spotifyUrl: match.url,
          isrc: code,
        },
        {
          subjectKind: 'track',
          subjectId: similarTrack.id,
          operation: 'spotify-code-search',
          key: jobId,
          jobId,
          position: 1,
        },
      )
    })
    await storeSpotifyCodeLookup({
      kind: 'track',
      key: code,
      itemId: similarTrack.id,
      match,
      jobId,
    })
  }

  // TIDAL track matches for the Similar tab: one left two TIDAL tracks for
  // review, and TIDAL had no track for another's ISRC. The rest have no ISRC.
  const tidalMatches = [
    { track: standalone[0], isrc: 'QZFX22600001', review: true },
    { track: standalone[1], isrc: 'QZFX22600002', review: false },
  ]
  for (const [index, { track, isrc, review }] of tidalMatches.entries()) {
    if (!track) continue
    await db
      .update(schema.libraryTrack)
      .set({ isrc })
      .where(eq(schema.libraryTrack.mediaItemId, track.id))
    const candidate = (n: number, version: string | null) => {
      const tidalTrackId = String(910000 + index * 10 + n)
      return {
        tidalTrackId,
        title: track.title,
        isrc,
        url: `https://tidal.com/browse/track/${tidalTrackId}`,
        version,
        durationSec: track.durationSec + n * 6,
        popularity: 0.4,
        streamable: true,
        albums: [
          {
            tidalAlbumId: String(920000 + index * 10 + n),
            title: version
              ? `${track.albumName} (${version})`
              : track.albumName,
            albumType: n === 1 ? 'SINGLE' : 'ALBUM',
            barcodeId: null,
            releaseDate: n === 1 ? '2021-03-05' : '2022-06-10',
          },
        ],
      }
    }
    const candidates = review
      ? [candidate(1, null), candidate(2, 'Extended Mix')]
      : []
    await addJob({
      provider: 'tidal',
      status: review ? 'succeeded' : 'failed',
      mediaType: null,
      options: {
        task: 'tidal-track-match',
        trackId: track.id,
        isrc,
        trackTitle: track.title,
        ...(review ? { reason: 'ambiguous', candidateCount: 2 } : {}),
      },
      createdAt: daysAgo(2),
      ...(review ? {} : { errorMessage: 'TIDAL has no track with this ISRC.' }),
      logs: ({ finishedAt }) =>
        finishedAt
          ? [
              {
                level: review ? 'info' : 'error',
                message: review
                  ? '2 TIDAL tracks share the ISRC. Choose one in review.'
                  : 'ProviderItemNotFoundError: TIDAL has no track with this ISRC.',
                metadata: {
                  diagnostics: [
                    {
                      kind: 'tidal-track-match',
                      isrc,
                      reason: review ? 'ambiguous' : 'none',
                      candidates,
                    },
                  ],
                  ...(review ? {} : { classification: 'not-found' }),
                },
                at: finishedAt,
              },
            ]
          : [],
    })
  }

  // ------------------------------------------------------------- playlists
  const albumTrackRows = await db
    .select({
      id: schema.track.trackMediaItemId,
      albumId: schema.track.albumMediaItemId,
    })
    .from(schema.track)
  const visibleAlbumIds = new Set(
    albums.filter((item) => !item.hidden).map((item) => item.id),
  )
  const libraryTrackIds = shuffle(
    albumTrackRows
      .filter((row) => visibleAlbumIds.has(row.albumId))
      .map((row) => row.id),
  )
  const standaloneIds = standalone.map((track) => track.id)
  const playlists = [
    {
      name: 'Everything Lately',
      source: null,
      entries: [
        ...libraryTrackIds.slice(0, 92),
        ...standaloneIds.slice(0, 16),
        ...shuffle([...visibleAlbumIds]).slice(0, 12),
      ],
      schedule: 'off',
      editable: true,
    },
    {
      name: 'Morning Commute',
      source: 'spotify',
      entries: [
        ...libraryTrackIds.slice(92, 120),
        ...standaloneIds.slice(16, 22),
      ],
      schedule: 'daily',
      editable: true,
    },
    {
      name: 'Liked Songs',
      source: 'spotify-liked',
      entries: [
        ...libraryTrackIds.slice(120, 160),
        ...standaloneIds.slice(20, 28),
      ],
      schedule: 'weekly',
      editable: true,
    },
    {
      name: 'Sunday Records',
      source: null,
      entries: [
        ...shuffle([...visibleAlbumIds]).slice(0, 3),
        ...libraryTrackIds.slice(160, 163),
      ],
      schedule: 'off',
      editable: true,
    },
    {
      name: 'New Finds',
      source: 'spotify',
      entries: [],
      schedule: 'off',
      editable: false,
    },
  ]
  for (const entry of playlists) {
    const id = createStableId(
      'playlist',
      `playlist:${entry.name.toLowerCase()}`,
    )
    const remote =
      entry.source === 'spotify' ? spotifyId(`playlist:${entry.name}`) : null
    await db.insert(schema.playlist).values({
      id,
      name: entry.name,
      kind: 'playlist',
      source: entry.source,
      spotifyId: remote,
      ownerName:
        entry.source === 'spotify'
          ? entry.editable
            ? 'Preview Owner'
            : 'Another Listener'
          : null,
      description:
        entry.source === 'spotify'
          ? `Synthetic playlist: ${entry.name.toLowerCase()}.`
          : null,
      artworkUrl: entry.entries.length
        ? artwork(`playlist:${entry.name}`)
        : null,
      spotifyUrl: remote ? `https://open.spotify.com/playlist/${remote}` : null,
      snapshotId: entry.source
        ? hash(`snapshot:${entry.name}`).slice(0, 32)
        : null,
      importedAt: entry.source ? at(between(2, 72) * HOUR) : null,
      checkedAt: entry.source ? at(between(1, 6) * HOUR) : null,
      syncSchedule: entry.schedule,
      syncUserId: entry.source ? USER_ID : null,
      spotifyEditable: entry.editable,
      createdAt: daysAgo(between(60, 700)),
    })
    for (const [position, mediaItemId] of entry.entries.entries())
      await db
        .insert(schema.playlistItem)
        .values({
          playlistId: id,
          mediaItemId,
          position,
          addedAt: daysAgo(between(1, 600)),
        })
        .onConflictDoNothing()
  }

  // ----------------------------------------------------------- scrobbles
  // About 15,000 over seven years: uneven months, a gap year and a burst in
  // the last 30 days. Sessions play runs of consecutive album tracks.
  const listenable = albums.filter((item) => item.scrobbled && !item.hidden)
  const scrobbles = new Map<string, typeof schema.lastfmScrobble.$inferInsert>()
  const add = (
    time: number,
    artistName: string,
    trackName: string,
    albumName: string | null,
  ) => {
    if (time >= NOW - MINUTE) return
    const uts = Math.floor(time / 1000)
    const id = createStableId(
      'scrobble',
      JSON.stringify([LISTENER, uts, artistName, trackName, albumName]),
    )
    scrobbles.set(id, {
      id,
      username: LISTENER,
      listenedAt: new Date(uts * 1000),
      artistName,
      albumName,
      trackName,
      artistKey: albumNameKey(artistName),
      albumKey: albumName ? albumNameKey(albumName) : null,
      trackKey: albumNameKey(trackName),
    })
  }
  const session = (start: number, target: number) => {
    let time = start
    if (random() < 0.07) {
      const outside = pick(OUTSIDE)
      for (let index = 0; index < between(1, 4); index += 1) {
        const track = pick(
          standalone.filter((entry) => entry.artist === outside.artist),
        )
        add(time, outside.artist, track.title, outside.album)
        time += track.durationSec * 1000
      }
      return
    }
    const eligible = listenable.filter(
      (item) => item.dateAdded.getTime() <= start,
    )
    if (!eligible.length) return
    const total = eligible.reduce((sum, item) => sum + item.favourite, 0)
    let roll = random() * total
    const chosen =
      eligible.find((item) => (roll -= item.favourite) <= 0) ?? pick(eligible)
    const from = random() < 0.6 ? 0 : between(0, chosen.tracks.length - 1)
    const length = Math.min(target, between(3, chosen.tracks.length))
    for (let index = 0; index < length; index += 1) {
      const track = chosen.tracks[(from + index) % chosen.tracks.length]
      if (!track) continue
      add(time, chosen.artists[0] ?? '', track.title, chosen.title)
      time += (track.durationSec + between(0, 20)) * 1000
    }
  }
  const monthWeights = Array.from({ length: 84 }, (_, monthsAgo) => {
    if (monthsAgo >= 36 && monthsAgo < 48) return 0
    const busy = random() < 0.12 ? 3 : 1
    return (0.25 + random() * 1.6) * busy
  })
  const weightTotal = monthWeights.reduce((sum, value) => sum + value, 0)
  for (const [monthsAgo, weight] of monthWeights.entries()) {
    const end = NOW - 31 * DAY - monthsAgo * 30.4 * DAY
    const start = end - 30.4 * DAY
    const target = Math.round((13_800 * weight) / weightTotal)
    const before = scrobbles.size
    for (
      let guard = 0;
      scrobbles.size - before < target && guard < 2000;
      guard += 1
    )
      session(
        between(start, end - 2 * HOUR),
        target - (scrobbles.size - before),
      )
  }
  const burstStart = scrobbles.size
  for (
    let guard = 0;
    scrobbles.size - burstStart < 1200 && guard < 2000;
    guard += 1
  )
    session(
      between(NOW - 30 * DAY, NOW - 3 * HOUR),
      1200 - (scrobbles.size - burstStart),
    )
  const rows = [...scrobbles.values()]
  for (let index = 0; index < rows.length; index += 500)
    await db
      .insert(schema.lastfmScrobble)
      .values(rows.slice(index, index + 500))
  await db.insert(schema.lastfmSync).values({
    username: LISTENER,
    status: 'complete',
    schedule: 'daily',
    windowFrom: null,
    windowTo: Math.floor((NOW - 2 * HOUR) / 1000),
    nextPage: 1,
    totalPages: 76,
    newScrobbles: 42,
    syncedThrough: Math.floor((NOW - 2 * HOUR) / 1000),
    startedAt: at(2 * HOUR + 5 * MINUTE),
    completedAt: at(2 * HOUR),
    requestedByUserId: USER_ID,
  })
  // Links scrobbles to albums and tracks and stores the album listening values.
  await relinkLastfmScrobbles()
  console.log('scrobbles:', rows.length)

  // ---------------------------------------------------- provider request state
  const minuteOfDay = NOW - Math.floor(NOW / DAY) * DAY
  const events: Array<typeof schema.providerRequestEvent.$inferInsert> = []
  const recent = new Map<string, number[]>()
  const spread = (
    provider: string,
    count: number,
    from: number,
    to: number,
    shape: (fraction: number) => number,
    requestClass = 'read',
  ) => {
    for (let index = 0; index < count; index += 1) {
      let time = from + random() * (to - from)
      // Rejection sampling for uneven hourly shapes.
      for (
        let tries = 0;
        tries < 20 && random() > shape((time - from) / Math.max(1, to - from));
        tries += 1
      )
        time = from + random() * (to - from)
      events.push({
        id: `pvreq-${provider}-${events.length}`,
        provider,
        requestedAt: new Date(time),
        requestClass,
      })
      if (time > NOW - HOUR)
        recent.set(provider, [
          ...(recent.get(provider) ?? []),
          Math.round(time),
        ])
    }
  }
  spread('spotify', 280, NOW - DAY, NOW - MINUTE, (f) =>
    f > 0.8 || (f > 0.3 && f < 0.4) ? 1 : 0.15,
  )
  spread('spotify', 18, NOW - 20 * HOUR, NOW - 2 * HOUR, () => 1, 'write')
  spread('musicbrainz', 420, NOW - 3 * HOUR, NOW - 45 * MINUTE, () => 1)
  spread('musicbrainz', 120, NOW - DAY, NOW - 3 * HOUR, (f) =>
    f < 0.3 ? 1 : 0.2,
  )
  spread('discogs', 180, NOW - DAY, haltedAt, (f) => 0.4 + f * 0.6)
  spread('lastfm', 260, NOW - DAY, NOW - MINUTE, (f) => (f > 0.85 ? 1 : 0.3))
  spread('omdb', 90, NOW - DAY, NOW - HOUR, () => 0.6)
  spread('tmdb', 120, NOW - DAY, NOW - 30 * MINUTE, (f) => (f < 0.5 ? 0.3 : 1))
  spread('serply', 25, NOW - 12 * HOUR, NOW - 5 * MINUTE, () => 1)
  spread('youtube', 140, NOW - 26 * HOUR, NOW - 22 * HOUR, () => 1)
  // MDBList: most of a lowered daily budget used since midnight UTC.
  spread('mdblist', 860, NOW - minuteOfDay + 1000, NOW - 2 * MINUTE, () => 1)
  spread('mdblist', 300, NOW - DAY, NOW - minuteOfDay, () => 0.5)
  for (let index = 0; index < events.length; index += 500)
    await db
      .insert(schema.providerRequestEvent)
      .values(events.slice(index, index + 500))
  const states: Array<typeof schema.providerRequestState.$inferInsert> = [
    {
      provider: 'musicbrainz',
      cooldownUntil: new Date(cooldownUntil),
      failureCount: 3,
      lastError: 'MusicBrainz rate limited the request (HTTP 503)',
    },
    {
      provider: 'discogs',
      halted: true,
      failureCount: 1,
      lastError: 'Discogs denied access (HTTP 401). Update the token.',
    },
    {
      provider: 'mdblist',
      requestBudgetOverride: { period: 'day', limit: 1000 },
      budgetUpdatedByUserId: USER_ID,
    },
    { provider: 'spotify' },
    { provider: 'lastfm' },
    { provider: 'omdb' },
    { provider: 'tmdb', failureCount: 0, lastError: null },
    { provider: 'serply' },
    { provider: 'youtube' },
  ]
  for (const state of states)
    await db.insert(schema.providerRequestState).values({
      ...state,
      historyStartedAt: daysAgo(400),
      requests: (recent.get(state.provider) ?? []).sort(
        (left, right) => left - right,
      ),
      nextAllowedAt: at(between(0, 30) * 1000),
    })
  await db.insert(schema.providerCooldownReset).values({
    id: 'pv-cooldown-reset',
    provider: 'musicbrainz',
    previousCooldownUntil: daysAgo(5),
    clearedAt: new Date(NOW - 5 * DAY - 20 * MINUTE),
    userId: USER_ID,
  })

  // --------------------------------------------------------- subscriptions
  await db.execute(sql`
    insert into subscription_source
      (id, type, title, handle, description, thumbnail_url, subscriber_count, item_total, read_item_total, subscribed, history_complete)
    values
      ('UCpv00000000000000000001', 'youtube', 'Field Notes Weekly', '@fieldnotesweekly', 'Synthetic channel about walks and maps.', null, 120000, 14, 14, true, true),
      ('UCpv00000000000000000002', 'youtube', 'Circuit Bench', '@circuitbench', 'Synthetic channel about repairing radios.', null, 48000, 12, 12, true, true),
      ('UCpv00000000000000000003', 'youtube', 'Slow Kitchen', null, 'Synthetic channel about bread.', null, null, 30, 10, true, false),
      ('pvshow0000000000000001', 'spotify', 'The Long Margin', null, 'Synthetic podcast about footnotes.', ${artwork('show:margin')}, null, 12, null, true, true)`)
  const topics = sql`array['soldering','sourdough','tide pools','typography','night trains','bird migration','compression','repair culture','old maps','weather radios']`
  await db.execute(sql`
    with rows as (
      select n,
        'pvvid' || lpad(n::text, 6, '0') as id,
        'UCpv0000000000000000000' || (1 + n % 3) as source_id,
        'youtube' as type,
        (array['Understanding','Notes on','A short history of','Fixing','Inside','Field guide to'])[1 + n % 6] || ' ' || (${topics})[1 + n % 10] as title,
        'Synthetic description about ' || (${topics})[1 + (n + 3) % 10] || '.' as description,
        jsonb_build_array((${topics})[1 + n % 10], 'synthetic') as tags,
        (now() at time zone 'utc') - (n * 37 || ' hours')::interval as published_at,
        'time' as published_precision,
        case when n = 29 then 0 else 180 + (n * 523) % 3600 end as duration_sec,
        (n * 7919) % 400000 as view_count,
        (n * 31) % 9000 as like_count,
        (n * 13) % 600 as comment_count,
        case when n = 29 then 'upcoming' else 'none' end as live,
        null::text as artwork_url
      from generate_series(1, 30) n
      union all
      select n,
        'pvep' || lpad(n::text, 18, '0'),
        'pvshow0000000000000001',
        'spotify',
        'Episode ' || (13 - n) || ': ' || (${topics})[1 + n % 10],
        'Synthetic episode notes on ' || (${topics})[1 + (n + 5) % 10] || '.',
        '[]'::jsonb,
        date_trunc('day', (now() at time zone 'utc')) - (n * 9 || ' days')::interval,
        case when n = 12 then 'month' else 'day' end,
        1500 + (n * 211) % 3600,
        null, null, null, 'none', ${artwork('show:margin')}
      from generate_series(1, 12) n
    )
    insert into subscription_item
      (id, source_id, type, title, description, tags, published_at, published_precision,
       duration_sec, view_count, like_count, comment_count, live, artwork_url, search)
    select r.id, r.source_id, r.type, r.title, r.description, r.tags, r.published_at,
      r.published_precision, r.duration_sec, r.view_count, r.like_count, r.comment_count,
      r.live, r.artwork_url,
      setweight(to_tsvector('english', r.title), 'A') ||
      setweight(to_tsvector('english', s.title || ' ' || coalesce((select string_agg(t, ' ') from jsonb_array_elements_text(r.tags) t), '')), 'B') ||
      setweight(to_tsvector('english', r.description), 'D') ||
      setweight(to_tsvector('simple', r.title), 'A') ||
      setweight(to_tsvector('simple', s.title || ' ' || coalesce((select string_agg(t, ' ') from jsonb_array_elements_text(r.tags) t), '')), 'B') ||
      setweight(to_tsvector('simple', r.description), 'D')
    from rows r join subscription_source s on s.id = r.source_id`)
  await db.insert(schema.subscriptionSync).values([
    {
      userId: USER_ID,
      provider: 'youtube',
      status: 'complete',
      schedule: 'daily',
      phase: 'items',
      sourcesDone: 3,
      sourcesTotal: 3,
      newItems: 12,
      startedAt: daysAgo(1),
      completedAt: new Date(NOW - DAY + 3 * MINUTE),
    },
    {
      userId: USER_ID,
      provider: 'spotify',
      status: 'failed',
      schedule: 'daily',
      phase: 'items',
      sourcesDone: 0,
      sourcesTotal: 1,
      errorMessage: 'Spotify request failed (HTTP 502)',
      startedAt: daysAgo(2),
    },
  ])

  // ---------------------------------------------------------------- mixes
  await db.execute(sql`
    insert into subscription_source (id, type, title, handle, url, item_total, subscribed, history_complete)
    values
      ('nts.pv-tidal-hours', 'nts', 'Tidal Hours', 'pv-tidal-hours', 'https://www.nts.live/shows/pv-tidal-hours', 5, true, true),
      ('rinse.pv-lantern-club', 'rinse', 'Lantern Club', 'pv-lantern-club', 'https://www.rinse.fm/shows/pv-lantern-club', 4, true, true)`)
  await db.execute(sql`
    with rows as (
      select 'nts.pv-tidal-hours-' || n as id, 'nts.pv-tidal-hours' as source_id, 'nts' as type,
        'Tidal Hours w/ ' || (array['Mara Quill','Odd Weather','Mara Quill','Fen Static','Odd Weather'])[n] as title,
        jsonb_build_array((array['Mara Quill','Odd Weather','Mara Quill','Fen Static','Odd Weather'])[n]) as artists,
        jsonb_build_array((array['ambient','dub','ambient','techno','dub'])[n]) as tags,
        (now() at time zone 'utc') - (n * 6 || ' days')::interval as published_at,
        3600 + n * 600 as duration_sec
      from generate_series(1, 5) n
      union all
      select 'rinse.pv-lantern-club-' || n, 'rinse.pv-lantern-club', 'rinse',
        'Lantern Club ' || (array['warm-up','late set','b2b','closing set'])[n],
        jsonb_build_array((array['Juno Vale','Fen Static','Juno Vale','Odd Weather'])[n]),
        jsonb_build_array((array['house','techno','house','dub'])[n]),
        (now() at time zone 'utc') - (n * 9 + 2 || ' days')::interval,
        5400
      from generate_series(1, 4) n
    )
    insert into subscription_item
      (id, source_id, type, title, tags, artists, published_at, duration_sec, url, search)
    select r.id, r.source_id, r.type, r.title, r.tags, r.artists, r.published_at, r.duration_sec,
      s.url || '/episodes/' || r.id,
      setweight(to_tsvector('english', r.title), 'A') ||
      setweight(to_tsvector('english', s.title || ' ' || (select string_agg(t, ' ') from jsonb_array_elements_text(r.tags || r.artists) t)), 'B') ||
      setweight(to_tsvector('simple', r.title), 'A') ||
      setweight(to_tsvector('simple', s.title || ' ' || (select string_agg(t, ' ') from jsonb_array_elements_text(r.tags || r.artists) t)), 'B')
    from rows r join subscription_source s on s.id = r.source_id`)

  // ---------------------------------------------------- library playlists
  const { addLibraryPlaylistEntries, createLibraryPlaylist } =
    await import('@/services/library-playlists')
  const { CreateLibraryPlaylistSchema } =
    await import('@repo/schemas/library-playlists')
  // PL-02: only items each library's Browse lists at the In library scope.
  const { queryBrowseSelectionIds } = await import('@/services/browse')
  const { AlbumQuerySchema, FilmQuerySchema } =
    await import('@repo/schemas/media')
  const { TrackQuerySchema } = await import('@repo/schemas/tracks')
  const visibleTrackIds = shuffle(
    await queryBrowseSelectionIds('track', TrackQuerySchema.parse({}), 1000),
  )
  const albumIds = shuffle(
    await queryBrowseSelectionIds('album', AlbumQuerySchema.parse({}), 1000),
  )
  const filmIds = shuffle(
    await queryBrowseSelectionIds('film', FilmQuerySchema.parse({}), 1000),
  )
  const itemIds = async (type: string) =>
    z
      .array(z.object({ id: z.string() }))
      .parse(
        (
          await db.execute(
            sql`select id from subscription_item where type = ${type} order by published_at desc`,
          )
        ).rows,
      )
      .map((row) => row.id)
  const [videoIds, episodeIds, ntsIds, rinseIds] = await Promise.all([
    itemIds('youtube'),
    itemIds('spotify'),
    itemIds('nts'),
    itemIds('rinse'),
  ])
  const allMixIds = [...ntsIds, ...rinseIds]
  const libraryPlaylists = [
    { library: 'albums', name: 'Rainy Sundays', ids: albumIds.slice(0, 9) },
    { library: 'albums', name: 'Desert Island', ids: albumIds.slice(9, 14) },
    { library: 'albums', name: 'Empty Shelf', ids: [] },
    {
      library: 'tracks',
      name: 'Late Shift',
      ids: visibleTrackIds.slice(0, 24),
    },
    {
      library: 'tracks',
      name: 'Road Trip',
      ids: visibleTrackIds.slice(24, 42),
    },
    { library: 'tracks', name: 'Empty Crate', ids: [] },
    { library: 'films', name: 'Double Bills', ids: filmIds.slice(0, 6) },
    { library: 'films', name: 'Watch Next', ids: filmIds.slice(6, 10) },
    {
      library: 'subscriptions',
      name: 'Repair Evenings',
      ids: videoIds.slice(0, 7),
    },
    {
      library: 'subscriptions',
      name: 'Commute Listening',
      ids: episodeIds.slice(0, 5),
    },
    { library: 'mixes', name: 'After Midnight', ids: allMixIds.slice(0, 5) },
    { library: 'mixes', name: 'Warm-ups', ids: allMixIds.slice(5, 8) },
  ]
  const smartPlaylists = [
    {
      library: 'albums',
      name: 'Dream Pop, Newest First',
      view: {
        filters: JSON.stringify([
          { field: 'genre', value: 'dream pop', mode: 'any' },
        ]),
        sortBy: 'dateAdded',
        direction: 'desc',
      },
    },
    {
      library: 'tracks',
      name: 'Night Titles',
      view: { q: 'Night', sortBy: 'title', direction: 'asc' },
    },
    {
      library: 'films',
      name: 'Winter Films',
      view: { q: 'Winter', sortBy: 'releaseDate', direction: 'desc' },
    },
    {
      library: 'subscriptions',
      name: 'Radio Repairs',
      view: { q: 'radios' },
    },
    {
      library: 'mixes',
      name: 'Odd Weather Sets',
      view: {
        filters: JSON.stringify([
          { field: 'artist', value: 'Odd Weather', mode: 'required' },
        ]),
      },
    },
  ]
  for (const [index, entry] of [
    ...libraryPlaylists.map((playlist) => ({
      type: 'playlist',
      library: playlist.library,
      name: playlist.name,
      ...(playlist.ids.length ? { selection: { ids: playlist.ids } } : {}),
    })),
    ...smartPlaylists.map((playlist) => ({ type: 'smart', ...playlist })),
  ].entries()) {
    const { playlist } = await createLibraryPlaylist(
      CreateLibraryPlaylistSchema.parse(entry),
      USER_ID,
    )
    await db.execute(sql`update library_playlist
      set created_at = now() - make_interval(days => ${between(40, 400)}::int),
        updated_at = now() - make_interval(days => ${index + between(1, 20)}::int)
      where id = ${playlist.id}`)
  }
  // Late Shift holds three tracks a second time and Rainy Sundays two albums.
  const repeats: {
    library: 'tracks' | 'albums'
    name: string
    ids: string[]
  }[] = [
    { library: 'tracks', name: 'Late Shift', ids: visibleTrackIds.slice(3, 6) },
    { library: 'albums', name: 'Rainy Sundays', ids: albumIds.slice(1, 3) },
  ]
  for (const { library, name, ids } of repeats) {
    const [playlist] = await db
      .select({ id: schema.libraryPlaylist.id })
      .from(schema.libraryPlaylist)
      .where(
        and(
          eq(schema.libraryPlaylist.library, library),
          eq(schema.libraryPlaylist.name, name),
        ),
      )
    if (playlist) await addLibraryPlaylistEntries(playlist.id, { ids }, 'again')
  }
  await db.execute(sql`update library_playlist_entry
    set added_at = now() - ((position * 7 + length(id)) % 300 || ' hours')::interval`)

  console.log('jobs:', jobCount)
  await db.$client.end()
}

void main().catch(async (error: unknown) => {
  console.error(error)
  await db.$client.end()
  process.exit(1)
})
