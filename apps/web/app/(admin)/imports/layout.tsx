import ImportsWorkspace from '@/components/imports-workspace'

export default function ImportsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <ImportsWorkspace>{children}</ImportsWorkspace>
}
