import { redirect } from 'next/navigation'
import { youtubeImportHrefFromSubscriptions } from '@/utils/youtube-redirects'

export default async function YoutubeSubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  redirect(youtubeImportHrefFromSubscriptions(await searchParams))
}
