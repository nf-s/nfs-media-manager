'use client'

import { usePathname, useSearchParams } from 'next/navigation'
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from 'react'
import { z } from 'zod'
import {
  detailEntries,
  detailCrumbKey,
  detailEntryParams,
  detailLocation,
  detailPageHref,
  sameDetail,
  withoutDetailEntries,
  type DetailCrumb,
  type DetailEntry,
} from '@/utils/detail-inspector'

const InspectorHistorySchema = z.object({
  detailInspector: z.object({
    pushed: z.number().int().min(0),
    openedFromWorkspace: z.boolean(),
  }),
})

function inspectorHistory() {
  const parsed = InspectorHistorySchema.safeParse(window.history.state)
  return parsed.success ? parsed.data.detailInspector : null
}

/** Retain the inspector history entry when its underlying browse settings change. */
export function replaceWorkspaceUrl(url: string, keepInspector: boolean) {
  const history = keepInspector ? inspectorHistory() : null
  window.history.replaceState(
    history ? { detailInspector: history } : null,
    '',
    url,
  )
}

function currentLocation() {
  const { pathname, search, hash } = window.location
  const params = new URLSearchParams(search)
  return { pathname, params, hash, entries: detailEntries(pathname, params) }
}

function stepHistory(delta: number) {
  const current = currentLocation()
  const workspace = withoutDetailEntries(current.pathname, current.params)
  window.addEventListener(
    'popstate',
    () => {
      const previous = currentLocation()
      if (previous.pathname !== current.pathname) return
      const previousWorkspace = withoutDetailEntries(
        previous.pathname,
        previous.params,
      )
      if (previousWorkspace.toString() === workspace.toString()) return
      replaceWorkspaceUrl(
        detailLocation(
          previous.pathname,
          detailEntryParams(previous.pathname, workspace, previous.entries),
          previous.hash,
        ),
        Boolean(previous.entries.length),
      )
    },
    { once: true },
  )
  window.history.go(delta)
}

function changeHistory(
  method: 'pushState' | 'replaceState',
  entries: DetailEntry[],
  detailInspector = inspectorHistory(),
) {
  const { pathname, params, hash } = currentLocation()
  window.history[method](
    detailInspector ? { detailInspector } : null,
    '',
    detailLocation(
      pathname,
      detailEntryParams(pathname, params, entries),
      hash,
    ),
  )
}

type Navigation = {
  root: DetailEntry | undefined
  active: DetailEntry | undefined
  entries: DetailEntry[]
  canGoBack: boolean
  entryKey: string
  href: (target: DetailEntry) => string
  /** The URL of the path up to and including the entry at `index`. */
  hrefAt: (index: number) => string
  /** The workspace URL with the drawer closed. */
  closedHref: string
  open: (target: DetailEntry, trigger?: HTMLElement) => void
  /** With `from`, discard the replacement if the drawer has moved on. */
  replace: (target: DetailEntry, from?: DetailEntry) => void
  replaceView: (params: URLSearchParams) => void
  back: () => void
  /** Steps back to the entry at `index`, as Back would one step at a time. */
  backTo: (index: number) => void
  close: () => void
}

const DetailInspectorContext = createContext<Navigation | null>(null)
export const useDetailInspector = () => useContext(DetailInspectorContext)

export function DetailInspectorProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const params = new URLSearchParams(useSearchParams())
  const entries = detailEntries(pathname, params)
  const root = entries[0]
  const hasRoot = root !== undefined
  const active = entries.at(-1)
  const trigger = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!hasRoot && trigger.current?.isConnected)
      trigger.current.focus({ preventScroll: true })
  }, [hasRoot])

  const navigation: Navigation = {
    root,
    active,
    entries,
    canGoBack: entries.length > 1,
    entryKey: JSON.stringify([pathname, ...entries.map(detailCrumbKey)]),
    href: (target) =>
      detailLocation(
        pathname,
        detailEntryParams(
          pathname,
          params,
          sameDetail(active, target)
            ? target.view
              ? [...entries.slice(0, -1), target]
              : entries
            : [...entries, target],
        ),
      ),
    hrefAt: (index) =>
      detailLocation(
        pathname,
        detailEntryParams(pathname, params, entries.slice(0, index + 1)),
      ),
    closedHref: detailLocation(
      pathname,
      withoutDetailEntries(pathname, params),
    ),
    open(target, opener) {
      const current = currentLocation().entries
      if (sameDetail(current.at(-1), target)) {
        if (target.view)
          changeHistory('replaceState', [...current.slice(0, -1), target])
        return
      }
      if (!current.length) trigger.current = opener ?? null
      const history = current.length ? inspectorHistory() : null
      changeHistory('pushState', [...current, target], {
        pushed: (history?.pushed ?? 0) + 1,
        openedFromWorkspace: history?.openedFromWorkspace ?? !current.length,
      })
    },
    replace(target, from) {
      const current = currentLocation().entries
      if (from && !sameDetail(current.at(-1), from)) return
      changeHistory('replaceState', [...current.slice(0, -1), target])
    },
    replaceView(view) {
      const current = currentLocation().entries
      const entry = current.at(-1)
      if (entry)
        changeHistory('replaceState', [
          ...current.slice(0, -1),
          { ...entry, view: view.toString() || undefined },
        ])
    },
    back() {
      const current = currentLocation().entries
      if (current.length < 2) return
      if (inspectorHistory()?.pushed) stepHistory(-1)
      else changeHistory('replaceState', current.slice(0, -1), null)
    },
    backTo(index) {
      const current = currentLocation().entries
      const steps = current.length - 1 - index
      if (index < 0 || steps < 1) return
      if ((inspectorHistory()?.pushed ?? 0) >= steps) stepHistory(-steps)
      else changeHistory('replaceState', current.slice(0, index + 1), null)
    },
    close() {
      const history = inspectorHistory()
      if (history?.pushed && history.openedFromWorkspace)
        stepHistory(-history.pushed)
      else changeHistory('replaceState', [], null)
    },
  }

  return (
    <DetailInspectorContext.Provider value={navigation}>
      {children}
    </DetailInspectorContext.Provider>
  )
}

export const InspectorEntryContext = createContext<Pick<
  Navigation,
  'active' | 'replaceView'
> | null>(null)

/** What the drawer offers the item it shows; absent on a standalone page. */
export type InspectorPage = {
  /** The item's own page, with its current view. */
  pageHref: string
  /** Names the item in the drawer's breadcrumbs once its details load. */
  setCrumb: (crumb: DetailCrumb) => void
  /** Where the item's More actions go in the drawer bar on a phone. */
  moreSlot: HTMLElement | null
}

export const InspectorPageContext = createContext<InspectorPage | null>(null)
export const useInspectorPage = () => useContext(InspectorPageContext)

/** An inspector entry owns its view settings; a standalone detail uses its normal URL. */
export function useDetailView() {
  const inspector = useContext(InspectorEntryContext)
  const pathname = usePathname()
  const searchParams = useSearchParams()
  return {
    params: new URLSearchParams(
      inspector ? inspector.active?.view : searchParams,
    ),
    workspaceHref(params: URLSearchParams) {
      return inspector?.active
        ? detailPageHref(inspector.active, params)
        : detailLocation(pathname, withoutDetailEntries(pathname, params))
    },
    replace(params: URLSearchParams) {
      if (inspector) inspector.replaceView(params)
      else
        window.history.replaceState(
          null,
          '',
          detailLocation(
            window.location.pathname,
            params,
            window.location.hash,
          ),
        )
    },
    href(params: URLSearchParams) {
      const location = currentLocation()
      const entry = location.entries.at(-1)
      const next =
        inspector && entry
          ? detailEntryParams(location.pathname, location.params, [
              ...location.entries.slice(0, -1),
              { ...entry, view: params.toString() || undefined },
            ])
          : params
      return detailLocation(location.pathname, next, location.hash)
    },
  }
}
