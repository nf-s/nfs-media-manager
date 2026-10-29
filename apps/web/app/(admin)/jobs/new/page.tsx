import { redirect } from 'next/navigation'
import { mediaScope, scopedHref } from '@/utils/media-scope'

export default async function NewScrapePage({
  searchParams,
}: {
  searchParams: Promise<{ mediaType?: string }>
}) {
  const params = await searchParams
  redirect(scopedHref('/jobs/metadata', mediaScope(params.mediaType ?? null)))
}
