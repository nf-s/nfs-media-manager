import CollectionPageClient from '@/components/pages/collection-page-client'

export default async function CollectionDetailPage({
  params,
}: {
  params: Promise<{ collectionId: string }>
}) {
  const { collectionId } = await params
  return <CollectionPageClient collectionId={collectionId} />
}
