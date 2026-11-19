'use client'

import { useSyncExternalStore } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  replaceWorkspaceUrl,
  useDetailView,
} from '@/components/detail-inspector-context'
import { useNestedMediaView } from '@/components/nested-media-view'
import { withoutDetailEntries } from '@/utils/detail-inspector'
import {
  browseStateKeys,
  embeddedBrowseHref,
  embeddedLayout,
  embeddedLayoutKey,
  withEmbeddedLayout,
  type EmbeddedBrowse,
} from '@/utils/embedded-browse'
import {
  gridDensities,
  parseBrowseView,
  type BrowseView,
} from '@/utils/media-grid'
import { useNestedGridDensity } from './useGridDensity'

/** Where a Browse list keeps its settings: its page, or the detail it sits in. */
export type BrowseHost = {
  /** Inside a detail: no rail, no drawer of its own and no saved page state. */
  embedded: boolean
  /** The list's settings. */
  params: URLSearchParams
  /**
   * Changes the settings. `close` also closes the page's drawer; a list
   * inside a detail ignores it, since closing the drawer would remove the list.
   */
  update: (apply: (params: URLSearchParams) => void, close?: boolean) => void
  /** Names the list's column widths in browser storage. */
  storage: string
  /** The Browse page that shows this list with the same settings. */
  browseHref?: string
}

/**
 * A primary Browse page: settings in the page URL, remembered for next time.
 * `save` gives the part of the URL a page remembers, when that is not all of it.
 */
export function usePageBrowse(
  collection: string,
  save: (params: URLSearchParams) => string = (params) => params.toString(),
): BrowseHost {
  const searchParams = useSearchParams()
  const pathname = `/${collection}`
  return {
    embedded: false,
    params: new URLSearchParams(searchParams),
    update(apply, close = false) {
      const current = new URLSearchParams(window.location.search)
      const params = close ? withoutDetailEntries(pathname, current) : current
      apply(params)
      params.delete('page')
      replaceWorkspaceUrl(
        `${pathname}${params.size ? `?${params}` : ''}`,
        !close,
      )
      try {
        window.localStorage.setItem(
          `browse:${collection}`,
          save(withoutDetailEntries(pathname, params)),
        )
      } catch {
        /* URL state still works when browser storage is unavailable. */
      }
    },
    storage: collection,
  }
}

/*
 * The sort and columns of each list inside a detail, kept in browser storage.
 * Every open copy of a list reads the same store, so they change together.
 */
const layoutListeners = new Set<() => void>()
/** Layouts chosen while browser storage is unavailable, for this page load. */
const unsavedLayouts = new Map<string, string>()

function subscribeLayout(onChange: () => void) {
  layoutListeners.add(onChange)
  window.addEventListener('storage', onChange)
  return () => {
    layoutListeners.delete(onChange)
    window.removeEventListener('storage', onChange)
  }
}

function readLayout(key: string) {
  try {
    return window.localStorage.getItem(key) ?? unsavedLayouts.get(key) ?? ''
  } catch {
    return unsavedLayouts.get(key) ?? ''
  }
}

function saveLayout(key: string, layout: string) {
  if (readLayout(key) === layout) return
  unsavedLayouts.set(key, layout)
  try {
    window.localStorage.setItem(key, layout)
  } catch {
    // The layout holds for this page load.
  }
  for (const listener of layoutListeners) listener()
}

/**
 * A Browse list inside a detail. Its settings live in the detail's own view,
 * beside the open tab. The view, grid size, sort and columns chosen last are
 * kept in browser storage for the next detail; search and filters are not.
 */
export function useEmbeddedBrowse(
  collection: string,
  { scope, storage, mediaType, sort }: EmbeddedBrowse,
  defaultView: BrowseView,
): BrowseHost {
  const view = useDetailView()
  const [savedView, saveView] = useNestedMediaView(storage, defaultView)
  const [density, saveDensity] = useNestedGridDensity(
    mediaType,
    view.params.get('density'),
  )
  const layoutKey = embeddedLayoutKey(storage)
  const savedLayout = useSyncExternalStore(
    subscribeLayout,
    () => readLayout(layoutKey),
    () => '',
  )
  const settings = new URLSearchParams()
  for (const key of browseStateKeys) {
    const value = view.params.get(key)
    if (value !== null) settings.set(key, value)
  }
  const params = withEmbeddedLayout(settings, savedLayout, sort)
  params.set('view', parseBrowseView(params.get('view'), savedView))
  params.set('density', density)
  return {
    embedded: true,
    params,
    update(apply) {
      const previous = {
        view: view.params.get('view'),
        density: view.params.get('density'),
      }
      // The layout in effect joins the URL, so a change to part of it holds.
      const next = withEmbeddedLayout(view.params, savedLayout, sort)
      apply(next)
      next.delete('page')
      const nextView = next.get('view')
      if (nextView !== null && nextView !== previous.view)
        saveView(parseBrowseView(nextView, defaultView))
      const nextDensity = gridDensities.find(
        (value) => value === next.get('density'),
      )
      if (nextDensity && nextDensity !== previous.density)
        saveDensity(nextDensity)
      saveLayout(layoutKey, embeddedLayout(next))
      view.replace(next)
    },
    storage,
    browseHref: embeddedBrowseHref(collection, scope, params),
  }
}
