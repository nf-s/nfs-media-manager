import FilmCollectionPageClient from '@/components/pages/film-collection-page-client'

export default async function FilmCollectionDetailPage({
  params,
}: {
  params: Promise<{ collectionId: string }>
}) {
  const { collectionId } = await params
  return <FilmCollectionPageClient collectionId={collectionId} />
}
