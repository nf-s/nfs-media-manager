import ImportsPageClient from '@/components/pages/imports-page-client'
import { redirect } from 'next/navigation'

export default async function ImportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  if (params.mediaType === 'subscription')
    redirect('/imports/youtube?mediaType=subscription')
  return <ImportsPageClient />
}
