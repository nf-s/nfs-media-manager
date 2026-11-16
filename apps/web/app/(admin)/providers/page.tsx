import { redirect } from 'next/navigation'
import ProvidersPageClient from '@/components/pages/providers-page-client'
import { legacyProviderHref } from '@/utils/provider-overview'

export default async function ProvidersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const legacy = legacyProviderHref(
    new URLSearchParams(
      Object.entries(params).flatMap(([key, value]) =>
        value === undefined
          ? []
          : (Array.isArray(value) ? value : [value]).map((entry) => [
              key,
              entry,
            ]),
      ),
    ),
  )
  if (legacy) redirect(legacy)
  return <ProvidersPageClient />
}
