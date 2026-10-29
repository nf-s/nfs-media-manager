import JobsWorkspace from '@/components/jobs-workspace'

export default function JobsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <JobsWorkspace>{children}</JobsWorkspace>
}
