import { redirect } from 'next/navigation'
import { getUserServerSession } from '@/utils/getUserServerSession'

export default async function PageAuthGuard({
  children,
}: {
  children: React.ReactNode
}) {
  const { user } = await getUserServerSession()

  if (!user) {
    redirect('/login')
  }

  return children
}
