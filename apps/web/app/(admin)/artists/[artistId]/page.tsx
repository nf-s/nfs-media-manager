import { ArtistDetail } from '@/components/artist-detail'
import { DetailPage } from '@/components/detail-frame'

export default async function ArtistPage({
  params,
}: {
  params: Promise<{ artistId: string }>
}) {
  const { artistId } = await params
  return (
    <DetailPage back={{ href: '/artists', label: 'Back to artists' }}>
      <ArtistDetail id={artistId} />
    </DetailPage>
  )
}
