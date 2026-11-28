import { WorkspaceFrame } from './workspace-frame'
import AppNavigation from './app-navigation'
import SignOutButton from './sign-out-button'
import UserLink from './user-link'
import RefreshDataButton from './refresh-data-button'
import { LibrarySelector, MediaScopeContent } from './media-scope'
import PlaybackProvider from './playback-provider'
import PlayerDock from './player-dock'
import { PlayerPromptRestore } from './player-connections'
import { railSlotId } from '@/hooks/useRailSlot'
import { AppDetailInspector } from './detail-inspector'
import { DetailInspectorProvider } from './detail-inspector-context'
import { ResultLineProvider } from './result-line'

export default function AppShell({
  children,
  owner,
}: {
  children: React.ReactNode
  owner: string
}) {
  return (
    <PlaybackProvider>
      <WorkspaceFrame owner={owner}>
        <DetailInspectorProvider>
          <ResultLineProvider>
            <div className="app-shell">
              <aside className="app-rail">
                <div className="rail-head">
                  <LibrarySelector />
                </div>
                <AppNavigation />
                <div className="rail-section" id={railSlotId} />
                <div className="rail-foot">
                  <RefreshDataButton />
                  <PlayerPromptRestore />
                  <div className="rail-user-actions">
                    <UserLink />
                    <SignOutButton />
                  </div>
                </div>
              </aside>
              <main className="app-main">
                <MediaScopeContent>{children}</MediaScopeContent>
              </main>
              <AppDetailInspector />
              <PlayerDock />
            </div>
          </ResultLineProvider>
        </DetailInspectorProvider>
      </WorkspaceFrame>
    </PlaybackProvider>
  )
}
