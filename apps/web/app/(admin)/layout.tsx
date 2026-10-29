import AppShell from '@/components/app-shell'
import PageAuthGuard from '@/components/page-auth-guard'

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <PageAuthGuard>
      <AppShell>{children}</AppShell>
    </PageAuthGuard>
  )
}
