import Link from 'next/link'
import { PersonDetail } from '@/components/person-detail'

export default async function PersonPage({
  params,
}: {
  params: Promise<{ personId: string }>
}) {
  const { personId } = await params
  return (
    <div className="detail-page">
      <Link href="/people">Back to people</Link>
      <PersonDetail id={personId} />
    </div>
  )
}
