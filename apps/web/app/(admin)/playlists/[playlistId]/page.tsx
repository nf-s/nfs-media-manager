import PlaylistDetailPageClient from '@/components/pages/playlist-detail-page-client'

export default async function PlaylistDetailPage({
  params,
}: {
  params: Promise<{ playlistId: string }>
}) {
  const { playlistId } = await params
  return <PlaylistDetailPageClient playlistId={playlistId} />
}
