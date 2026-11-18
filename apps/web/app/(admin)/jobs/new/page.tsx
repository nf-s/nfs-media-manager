import { redirect } from 'next/navigation'
import { mediaScope, scopedHref } from '@/utils/media-scope'

export default async function NewScrapePage({
  searchParams,
}: {
  searchParams: Promise<{ mediaType?: string }>
}) {
  const params = await searchParams
  const library =
    params.mediaType === 'track'
      ? 'track'
      : mediaScope(params.mediaType ?? null)
  redirect(scopedHref('/jobs/metadata', library))
}
