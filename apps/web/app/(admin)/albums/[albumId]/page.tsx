import AlbumDetailPageClient from '@/components/pages/album-detail-page-client'

export default async function AlbumDetailPage({
  params,
}: {
  params: Promise<{ albumId: string }>
}) {
  const { albumId } = await params

  return <AlbumDetailPageClient albumId={albumId} />
}
