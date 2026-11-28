import LibraryPlaylistPageClient from '@/components/pages/library-playlist-page-client'

export default async function LibraryPlaylistPage({
  params,
}: {
  params: Promise<{ playlistId: string }>
}) {
  const { playlistId } = await params
  return <LibraryPlaylistPageClient playlistId={playlistId} />
}
