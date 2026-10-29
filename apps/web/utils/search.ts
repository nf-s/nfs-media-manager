import type { ReadonlyURLSearchParams } from 'next/navigation'

export function getPositiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value)

  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback
  }

  return Math.floor(parsed)
}

export function updateSearchParams(
  searchParams: ReadonlyURLSearchParams,
  updates: Record<string, string | number | null | undefined>,
): string {
  const next = new URLSearchParams(searchParams.toString())

  for (const [key, value] of Object.entries(updates)) {
    if (value === null || typeof value === 'undefined' || value === '') {
      next.delete(key)
      continue
    }

    next.set(key, String(value))
  }

  const queryString = next.toString()
  return queryString.length > 0 ? `?${queryString}` : ''
}
