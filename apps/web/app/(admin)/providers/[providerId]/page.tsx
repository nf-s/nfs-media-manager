import ProviderPageClient from '@/components/pages/provider-page-client'

export default async function ProviderPage({
  params,
}: {
  params: Promise<{ providerId: string }>
}) {
  const { providerId } = await params

  return <ProviderPageClient providerId={providerId} />
}
