import FilmDetailPageClient from '@/components/pages/film-detail-page-client'

export default async function FilmDetailPage({
  params,
}: {
  params: Promise<{ filmId: string }>
}) {
  const { filmId } = await params

  return <FilmDetailPageClient filmId={filmId} />
}
