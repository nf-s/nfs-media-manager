import { redirect } from 'next/navigation'

/** The hierarchy first lived here; it is now the Tags page itself. */
export default async function TagHierarchyRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const forwarded = new URLSearchParams()
  for (const [key, value] of Object.entries(await searchParams)) {
    if (value === undefined) continue
    for (const entry of Array.isArray(value) ? value : [value])
      forwarded.append(key, entry)
  }
  redirect(`/tags${forwarded.size ? `?${forwarded}` : ''}`)
}
