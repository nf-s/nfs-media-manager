import TagsWorkspace from '@/components/tags-workspace'

export default function TagsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <TagsWorkspace>{children}</TagsWorkspace>
}
