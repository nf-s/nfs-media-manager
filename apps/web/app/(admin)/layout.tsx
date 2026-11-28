import AppShell from '@/components/app-shell'
import PageAuthGuard from '@/components/page-auth-guard'
import { SignedInSession } from '@/components/providers'

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <PageAuthGuard>
      {(owner) => (
        <>
          <SignedInSession />
          <AppShell owner={owner}>{children}</AppShell>
        </>
      )}
    </PageAuthGuard>
  )
}
