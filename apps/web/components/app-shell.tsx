import AppNavigation from './app-navigation'
import SignOutButton from './sign-out-button'
import JobActivity from './job-activity'
import { LibrarySelector, MediaScopeContent } from './media-scope'

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <header className="app-header">
        <LibrarySelector />
        <AppNavigation />
        <JobActivity />
        <SignOutButton />
      </header>
      <main className="app-main">
        <MediaScopeContent>{children}</MediaScopeContent>
      </main>
    </div>
  )
}
