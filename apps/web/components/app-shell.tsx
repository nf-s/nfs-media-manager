import AppNavigation from './app-navigation'
import SignOutButton from './sign-out-button'
import UserLink from './user-link'
import RefreshDataButton from './refresh-data-button'
import JobActivity from './job-activity'
import { LibrarySelector, MediaScopeContent } from './media-scope'
import PlaybackProvider from './playback-provider'
import PlayerDock from './player-dock'
import { railSlotId } from '@/hooks/useRailSlot'
import { AppDetailInspector } from './detail-inspector'
import { DetailInspectorProvider } from './detail-inspector-context'

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <PlaybackProvider>
      <DetailInspectorProvider>
        <div className="app-shell">
          <aside className="app-rail">
            <div className="rail-head">
              <LibrarySelector />
            </div>
            <AppNavigation />
            <div className="rail-section" id={railSlotId} />
            <div className="rail-foot">
              <JobActivity />
              <RefreshDataButton />
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
      </DetailInspectorProvider>
    </PlaybackProvider>
  )
}
