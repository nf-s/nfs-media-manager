import { ChannelDetail } from '@/components/channel-detail'
import { DetailPage } from '@/components/detail-frame'

export default async function ChannelPage({
  params,
}: {
  params: Promise<{ channelId: string }>
}) {
  const { channelId } = await params
  return (
    <DetailPage
      back={{ href: '/subscriptions/channels', label: 'Back to channels' }}
    >
      <ChannelDetail id={channelId} />
    </DetailPage>
  )
}
