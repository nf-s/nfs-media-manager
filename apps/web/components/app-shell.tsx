import AppNavigation from './app-navigation'
import SignOutButton from './sign-out-button'
import JobActivity from './job-activity'
import { LibrarySelector, MediaScopeContent } from './media-scope'
import { railSlotId } from '@/hooks/useRailSlot'

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <aside className="app-rail">
        <div className="rail-head">
          <LibrarySelector />
        </div>
        <AppNavigation />
        <div className="rail-section" id={railSlotId} />
        <div className="rail-foot">
          <JobActivity />
          <SignOutButton />
        </div>
      </aside>
      <main className="app-main">
        <MediaScopeContent>{children}</MediaScopeContent>
      </main>
    </div>
  )
}
