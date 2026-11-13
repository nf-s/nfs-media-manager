import { redirect } from 'next/navigation'
import { subscriptionsHrefFromYoutube } from '@/utils/youtube-redirects'

export default async function YoutubeVideosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  redirect(subscriptionsHrefFromYoutube(await searchParams))
}
