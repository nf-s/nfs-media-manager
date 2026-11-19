import { ChannelDetail } from '@/components/channel-detail'
import { DetailPage } from '@/components/detail-frame'

export default async function ShowPage({
  params,
}: {
  params: Promise<{ showId: string }>
}) {
  const { showId } = await params
  return (
    <DetailPage back={{ href: '/mixes/shows', label: 'Back to shows' }}>
      <ChannelDetail id={showId} library="mixes" />
    </DetailPage>
  )
}
