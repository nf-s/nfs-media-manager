import { redirect } from 'next/navigation'
import { getUserServerSession } from '@/utils/getUserServerSession'

export default async function HomePage() {
  const { user } = await getUserServerSession()

  redirect(user ? '/albums' : '/login')
}
