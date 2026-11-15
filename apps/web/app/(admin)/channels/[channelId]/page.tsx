import Link from 'next/link'
import { ChannelDetail } from '@/components/channel-detail'

export default async function ChannelPage({
  params,
}: {
  params: Promise<{ channelId: string }>
}) {
  const { channelId } = await params
  return (
    <div className="detail-page">
      <Link href="/subscriptions/channels">Back to channels</Link>
      <ChannelDetail id={channelId} />
    </div>
  )
}
