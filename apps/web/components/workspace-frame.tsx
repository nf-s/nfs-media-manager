'use client'

import { Film, LayoutGrid, Music2 } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from 'react'
import {
  WorkspaceTabs,
  workspaceTabId,
} from '@repo/ui/components/ds/workspace-tabs'
import { useWorkspaceTabGestures } from '@/hooks/useWorkspaceTabGestures'
import { detailLocation } from '@/utils/detail-inspector'
import { useSignedInSession } from '@/utils/device-store/signed-in'
import { isSystemPath, libraryViewForPath } from '@/utils/media-scope'
import {
  captureScroll,
  locationHref,
  makeWorkspaceTab,
  readWorkspace,
  restoreScroll,
  saveWorkspace,
  workspaceRoute,
  type WorkspaceState,
  type WorkspaceTab,
} from '@/utils/workspace-tabs'
import { readLastLibrary, rememberLibrary } from './media-scope'
import { WorkspaceBrowseNavigation } from './workspace-tab-context'

const panelId = 'workspace-panel'
const currentTab = (state: WorkspaceState) =>
  state.tabs.find((tab) => tab.id === state.activeId)

function workspaceIcon(href: string) {
  const { area, isDetail } = workspaceRoute(href)
  const Icon =
    isDetail && area === 'films'
      ? Film
      : isDetail && ['tracks', 'albums'].includes(area)
        ? Music2
        : LayoutGrid
  return <Icon className="ds-i" />
}

/** A tab owns an address and its scroll positions. Only the selected Next route runs. */
export function WorkspaceFrame({
  owner,
  children,
}: {
  owner: string
  children: ReactNode
}) {
  // Only the session check renders the workspace, on every signed-in page.
  useSignedInSession()
  const pathname = usePathname()
  const params = useSearchParams()
  const route = detailLocation(pathname, new URLSearchParams(params))
  const router = useRouter()
  const [navigating, startTransition] = useTransition()
  const [state, setState] = useState<WorkspaceState>(() => ({
    activeId: 'initial',
    tabs: [makeWorkspaceTab('initial', route)],
  }))
  const model = useRef(state)
  const booted = useRef(false)
  const switching = useRef<WorkspaceTab | null>(null)
  const restored = useRef<WorkspaceTab | null>(null)
  const browseNavigation = useMemo(
    () => ({
      restored,
      replace: (href: string) => router.replace(href, { scroll: false }),
    }),
    [router],
  )
  const [announcement, setAnnouncement] = useState('')

  const publish = useCallback(
    (next: WorkspaceState) => {
      model.current = next
      setState(next)
      saveWorkspace(owner, next)
    },
    [owner],
  )

  useLayoutEffect(() => {
    if (booted.current) return
    booted.current = true
    const href = locationHref()
    const navigation = performance.getEntriesByType('navigation')[0]
    // A new browser tab can inherit sessionStorage from its opener. Only
    // a reload resumes that browser tab's workspace.
    const saved =
      navigation && 'type' in navigation && navigation.type === 'reload'
        ? readWorkspace(owner, href)
        : null
    const active = saved && currentTab(saved)
    if (saved && active) {
      rememberLibrary(active.library)
      restored.current = active
      publish(saved)
    } else {
      const fresh = makeWorkspaceTab(
        'initial',
        href,
        undefined,
        readLastLibrary(),
      )
      publish({ activeId: fresh.id, tabs: [fresh] })
    }
  }, [owner, publish])

  // Store committed Next navigations and native history changes (including
  // inspector stacks, search and sort) on the currently displayed tab.
  useLayoutEffect(() => {
    if (model.current.activeId !== state.activeId) return
    const href = locationHref()
    const pending = switching.current
    if (
      pending &&
      (pending.id !== state.activeId || (navigating && href !== pending.href))
    )
      return
    if (pending) switching.current = null
    const active = currentTab(model.current)
    if (!active) return
    if (href !== restored.current?.href) restored.current = null
    const library = isSystemPath(pathname)
      ? readLastLibrary()
      : libraryViewForPath(pathname, params.get('mediaType'))
    const samePage = active.href.split(/[?#]/, 1)[0] === pathname
    const label = workspaceRoute(
      href,
      samePage ? active.label : undefined,
    ).label
    if (
      active.href !== href ||
      active.label !== label ||
      active.library !== library
    ) {
      publish({
        ...model.current,
        tabs: model.current.tabs.map((tab) =>
          tab.id === active.id ? { ...tab, href, label, library } : tab,
        ),
      })
    }
  }, [route, navigating, state.activeId, pathname, params, publish])

  useEffect(() => {
    // Get the real item title when a direct detail URL finishes loading.
    if (!workspaceRoute(route).isDetail) return
    const main = document.querySelector('.app-main')
    if (!main) return
    function updateTitle() {
      const active = currentTab(model.current)
      if (!active || switching.current || active.href !== locationHref()) return
      const label = main
        ?.querySelector('.ds-page .ds-detail-title, .ds-page .ds-pagehead h1')
        ?.textContent?.trim()
      if (label && label !== active.label) {
        publish({
          ...model.current,
          tabs: model.current.tabs.map((tab) =>
            tab.id === active.id ? { ...tab, label } : tab,
          ),
        })
      }
    }
    updateTitle()
    const observer = new MutationObserver(updateTitle)
    observer.observe(main, {
      subtree: true,
      childList: true,
      characterData: true,
    })
    return () => observer.disconnect()
  }, [route, state.activeId, publish])

  useEffect(() => {
    const tab = restored.current
    if (tab?.id === state.activeId && tab.href === locationHref()) {
      return restoreScroll(tab.scroll)
    }
  }, [state.activeId, route])

  function snapshot() {
    const previous = model.current
    if (switching.current || previous.activeId !== state.activeId)
      return previous
    const href = locationHref()
    const scroll = captureScroll()
    return {
      ...previous,
      tabs: previous.tabs.map((tab) => {
        if (tab.id !== previous.activeId) return tab
        const samePath =
          tab.href.split(/[?#]/, 1)[0] === window.location.pathname
        return {
          ...tab,
          href,
          scroll,
          label: workspaceRoute(href, samePath ? tab.label : undefined).label,
          library: readLastLibrary(),
        }
      }),
    }
  }

  useEffect(() => {
    function beforeReload() {
      if (switching.current) return
      // Logout removes the key before its full document navigation.
      const previous = model.current
      if (!readWorkspace(owner, currentTab(previous)?.href ?? '')) return
      const href = locationHref()
      const scroll = captureScroll()
      saveWorkspace(owner, {
        ...previous,
        tabs: previous.tabs.map((tab) =>
          tab.id === previous.activeId ? { ...tab, href, scroll } : tab,
        ),
      })
    }
    window.addEventListener('pagehide', beforeReload)
    return () => window.removeEventListener('pagehide', beforeReload)
  }, [owner])

  function activate(tabs: WorkspaceTab[], tab: WorkspaceTab) {
    const next = { tabs, activeId: tab.id }
    const inFlight = switching.current !== null
    switching.current = tab
    model.current = next
    const target = new URL(tab.href, window.location.origin)
    startTransition(() => {
      // A switch starts a new inspector history boundary. Its Back and Close
      // actions can reconstruct their path from the restored URL itself.
      if (target.pathname === window.location.pathname && !inFlight)
        window.history.replaceState(null, '', tab.href)
      else router.replace(tab.href, { scroll: false })
      rememberLibrary(tab.library)
      restored.current = tab
      publish(next)
    })
  }

  useWorkspaceTabGestures((href, label) => {
    const next = snapshot()
    const tab = makeWorkspaceTab(
      crypto.randomUUID(),
      href,
      label,
      readLastLibrary(),
    )
    publish({ ...next, tabs: [...next.tabs, tab] })
    setAnnouncement(
      tab.label +
        ' opened in a background tab. ' +
        (next.tabs.length + 1) +
        ' tabs open.',
    )
  })

  return (
    <div className="workspace-frame">
      <WorkspaceTabs
        panelId={panelId}
        tabs={state.tabs.map((tab) => ({
          ...tab,
          icon: workspaceIcon(tab.href),
        }))}
        activeId={state.activeId}
        onSelect={(id) => {
          if (id === model.current.activeId) return
          const next = snapshot()
          const tab = next.tabs.find((tab) => tab.id === id)
          if (tab) activate(next.tabs, tab)
        }}
        onDuplicate={() => {
          const next = snapshot()
          const source = currentTab(next)
          if (!source) return
          const tab = { ...source, id: crypto.randomUUID() }
          activate([...next.tabs, tab], tab)
          setAnnouncement(
            source.label +
              ' duplicated. ' +
              (next.tabs.length + 1) +
              ' tabs open.',
          )
        }}
        onClose={(id) => {
          const next = snapshot()
          const index = next.tabs.findIndex((tab) => tab.id === id)
          const closed = next.tabs[index]
          if (!closed) return
          const tabs = next.tabs.filter((tab) => tab.id !== id)
          if (id !== next.activeId) publish({ ...next, tabs })
          else {
            const neighbour = tabs[Math.min(index, tabs.length - 1)]
            if (neighbour) activate(tabs, neighbour)
            else {
              const fresh = makeWorkspaceTab(crypto.randomUUID(), '/films')
              activate([fresh], fresh)
            }
          }
          setAnnouncement(closed.label + ' tab closed.')
        }}
      />
      <div className="sr-only" role="status">
        {announcement}
      </div>
      <div
        className="workspace-panel"
        id={panelId}
        role="tabpanel"
        aria-labelledby={workspaceTabId(panelId, state.activeId)}
      >
        <WorkspaceBrowseNavigation.Provider
          key={state.activeId}
          value={browseNavigation}
        >
          {children}
        </WorkspaceBrowseNavigation.Provider>
      </div>
    </div>
  )
}
