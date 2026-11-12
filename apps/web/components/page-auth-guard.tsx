import { redirect } from 'next/navigation'
import { getUserServerSession } from '@/utils/getUserServerSession'

export default async function PageAuthGuard({
  children,
}: {
  children: React.ReactNode
}) {
  const { user, session } = await getUserServerSession()

  if (!user || !session || session.userId !== user.id) {
    redirect('/login')
  }

  return children
}
