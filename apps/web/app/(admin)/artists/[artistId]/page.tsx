import Link from 'next/link'
import { ArtistDetail } from '@/components/artist-detail'

export default async function ArtistPage({
  params,
}: {
  params: Promise<{ artistId: string }>
}) {
  const { artistId } = await params
  return (
    <div className="detail-page">
      <Link href="/artists">Back to artists</Link>
      <ArtistDetail id={artistId} />
    </div>
  )
}
