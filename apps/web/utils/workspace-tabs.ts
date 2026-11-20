import { z } from 'zod'
import { isWorkspaceHref } from './workspace-tab-destination'
import {
  albumImportDestinations,
  importDestinations,
  mixImportDestinations,
  subscriptionImportDestinations,
  trackImportDestinations,
} from './import-navigation'
import { isSystemPath, libraryViewForPath, type Library } from './media-scope'

const storageKey = 'media-manager:workspace-tabs'

const scrollAreas = {
  page: '.app-main',
  rail: '.rail-section',
  browse:
    '.app-main :is(.browse-scroller, .browse-scroll):not([data-inspector-scroll])',
  section: '.app-main :is(.section-content, .sec-scroll)',
  table: '.app-main .ds-table-wrap:not([data-inspector-scroll])',
  inspector: '.media-inspector:not(.player-sheet) .inspector-scroll',
  detailTable: '.media-inspector:not(.player-sheet) [data-inspector-scroll]',
}

const ScrollPosition = z.object({
  area: z.enum([
    'page',
    'rail',
    'browse',
    'section',
    'table',
    'inspector',
    'detailTable',
  ]),
  index: z.number().int().nonnegative(),
  top: z.number().finite().nonnegative(),
  left: z.number().finite(),
})
const WorkspaceTabSchema = z.object({
  id: z.string().min(1),
  href: z.string().refine(isWorkspaceHref),
  label: z.string(),
  scroll: z.array(ScrollPosition),
  library: z.enum(['film', 'album', 'artist', 'track', 'subscription', 'mix']),
})
export type WorkspaceTab = z.infer<typeof WorkspaceTabSchema>
const WorkspaceStateSchema = z
  .object({
    activeId: z.string(),
    tabs: z.array(WorkspaceTabSchema).min(1),
  })
  .refine(
    ({ activeId, tabs }) =>
      tabs.some((tab) => tab.id === activeId) &&
      new Set(tabs.map((tab) => tab.id)).size === tabs.length,
  )
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>
const StoredWorkspace = z.object({
  owner: z.string(),
  state: WorkspaceStateSchema,
})

export function readWorkspace(
  owner: string,
  href: string,
): WorkspaceState | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey)
    if (!raw) return null
    const result = StoredWorkspace.safeParse(JSON.parse(raw))
    if (!result.success || result.data.owner !== owner) return null
    const state = result.data.state
    return state.tabs.find((tab) => tab.id === state.activeId)?.href === href
      ? state
      : null
  } catch {
    return null
  }
}

export function saveWorkspace(owner: string, state: WorkspaceState) {
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify({ owner, state }))
  } catch {
    // Tabs still work in memory if session storage is unavailable or full.
  }
}

export function forgetWorkspace() {
  try {
    window.sessionStorage.removeItem(storageKey)
  } catch {
    // The full navigation after signing out also drops in-memory tabs.
  }
}

export function locationHref() {
  return (
    window.location.pathname + window.location.search + window.location.hash
  )
}

const sectionLabels = new Map(
  Object.entries({
    films: 'Films',
    albums: 'Albums',
    tracks: 'Tracks',
    artists: 'Artists',
    people: 'People',
    mixes: 'Mixes',
    subscriptions: 'Subscriptions',
    channels: 'Channels',
    shows: 'Shows',
    collections: 'Collections',
    playlists: 'Playlists',
    jobs: 'Jobs',
    providers: 'Providers',
    imports: 'Imports',
    tags: 'Tags',
    user: 'Account',
  }),
)

const importLabels = new Map(
  [
    ...importDestinations([]),
    ...albumImportDestinations(),
    ...subscriptionImportDestinations(),
    ...mixImportDestinations(),
  ].map((item) => [item.href, item.label]),
)

const sections = new Map([
  ['/subscriptions/channels', 'Channels'],
  ['/mixes/shows', 'Shows'],
  ['/jobs/metadata', 'Metadata'],
  ['/jobs/new', 'Metadata'],
  ['/jobs/refresh', 'Metadata'],
  ['/tracks/spotify-match-audit', 'Spotify match audit'],
  ['/tags/all', 'All tags'],
  ['/tags/hidden', 'Hidden tags'],
  ['/tags/hierarchy', 'Hierarchy'],
  ...['albums', 'artists', 'films', 'subscriptions', 'tracks'].map(
    (library): [string, string] => ['/' + library + '/matches', 'Matches'],
  ),
])

export function workspaceRoute(href: string, destinationLabel?: string) {
  const url = new URL(href, 'https://media.invalid')
  const [area = '', subpage] = url.pathname.split('/').filter(Boolean)
  const areaLabel = sectionLabels.get(area) ?? 'Library'
  const path = url.pathname.replace(/\/$/, '')
  const importLabel =
    area === 'imports' && url.searchParams.get('mediaType') === 'track'
      ? trackImportDestinations().find((item) => item.href === path)?.label
      : undefined
  const section = sections.get(path) ?? importLabel ?? importLabels.get(path)
  const isDetail =
    !section &&
    (Boolean(subpage) || (area === 'tags' && url.searchParams.has('tag')))
  const label =
    section ?? (isDetail && destinationLabel ? destinationLabel : areaLabel)
  const search = !subpage && !isDetail && url.searchParams.get('q')
  return { label: search ? label + ' · ' + search : label, isDetail, area }
}

export function makeWorkspaceTab(
  id: string,
  href: string,
  label?: string,
  railLibrary?: Library,
): WorkspaceTab {
  const url = new URL(href, 'https://media.invalid')
  return {
    id,
    href,
    label: workspaceRoute(href, label).label,
    scroll: [],
    library:
      isSystemPath(url.pathname) && railLibrary
        ? railLibrary
        : libraryViewForPath(url.pathname, url.searchParams.get('mediaType')),
  }
}

export function captureScroll(): WorkspaceTab['scroll'] {
  const positions: WorkspaceTab['scroll'] = []
  for (const area of ScrollPosition.shape.area.options) {
    document.querySelectorAll(scrollAreas[area]).forEach((el, index) => {
      if (el.scrollTop || el.scrollLeft)
        positions.push({ area, index, top: el.scrollTop, left: el.scrollLeft })
    })
  }
  return positions
}

/** Virtual lists may acquire their scroll extent only after their first page arrives. */
export function restoreScroll(positions: WorkspaceTab['scroll']) {
  if (!positions.length) return
  let frame = 0
  let pending = positions.slice()
  const observer = new MutationObserver(schedule)
  const resized = new ResizeObserver(schedule)
  const events = ['wheel', 'pointerdown', 'touchstart', 'keydown']
  function stop() {
    cancelAnimationFrame(frame)
    observer.disconnect()
    resized.disconnect()
    for (const event of events) window.removeEventListener(event, stop, true)
  }
  function apply() {
    frame = 0
    pending = pending.filter(({ area, index, top, left }) => {
      const el = document.querySelectorAll(scrollAreas[area]).item(index)
      if (!el) return true
      resized.observe(el)
      if (el.firstElementChild) resized.observe(el.firstElementChild)
      el.scrollTo({ top, left, behavior: 'instant' })
      return (
        Math.abs(el.scrollTop - top) > 1 || Math.abs(el.scrollLeft - left) > 1
      )
    })
    if (!pending.length) stop()
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(apply)
  }
  const shell = document.querySelector('.app-shell')
  if (shell)
    observer.observe(shell, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style'],
    })
  for (const event of events)
    window.addEventListener(event, stop, { capture: true, passive: true })
  schedule()
  return stop
}
