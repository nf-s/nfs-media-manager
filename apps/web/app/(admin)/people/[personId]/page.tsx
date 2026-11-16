import { PersonDetail } from '@/components/person-detail'
import { DetailPage } from '@/components/detail-frame'

export default async function PersonPage({
  params,
}: {
  params: Promise<{ personId: string }>
}) {
  const { personId } = await params
  return (
    <DetailPage back={{ href: '/people', label: 'Back to people' }}>
      <PersonDetail id={personId} />
    </DetailPage>
  )
}
