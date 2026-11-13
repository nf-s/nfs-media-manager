import type { z } from 'zod'
import type { FileImportFormatSchema } from '@repo/schemas/imports'

type ImportFormat = z.infer<typeof FileImportFormatSchema>

export function csvImportHref(format: string) {
  return `/imports/csv?${new URLSearchParams({ format })}`
}

export function resolveCsvFormat(
  formats: ImportFormat[],
  requested: string | null,
) {
  const csvFormats = formats.filter((format) => format.kind === 'csv')
  return requested === null
    ? csvFormats[0]
    : csvFormats.find((format) => format.id === requested)
}

export function importDestinations(formats: ImportFormat[]) {
  return [
    { id: '/imports', href: '/imports', label: 'Recent imports' },
    ...formats
      .filter((format) => format.kind === 'csv')
      .map((format) => ({
        id: csvImportHref(format.id),
        href: csvImportHref(format.id),
        label: format.label,
      })),
    ...(formats.some((format) => format.kind === 'csv')
      ? []
      : [{ id: '/imports/csv', href: '/imports/csv', label: 'Import CSV' }]),
    {
      id: '/imports/nfo',
      href: '/imports/nfo',
      label: 'Find new NFO films',
    },
    {
      id: '/imports/legacy',
      href: '/imports/legacy',
      label: 'Legacy JSON library',
    },
  ]
}

export function albumImportDestinations() {
  return [
    { id: '/imports', href: '/imports', label: 'Recent imports' },
    {
      id: '/imports/spotify',
      href: '/imports/spotify',
      label: 'Spotify saved albums',
    },
    {
      id: '/imports/spotify-playlists',
      href: '/imports/spotify-playlists',
      label: 'Spotify playlists',
    },
    {
      id: '/imports/lastfm',
      href: '/imports/lastfm',
      label: 'Last.fm scrobbles',
    },
    { id: '/imports/albums', href: '/imports/albums', label: 'Album CSV' },
    {
      id: '/imports/legacy',
      href: '/imports/legacy',
      label: 'Legacy JSON library',
    },
  ]
}

/** The Subscriptions library has no import history; each page shows its own sync. */
export function subscriptionImportDestinations() {
  return [
    { id: '/imports/youtube', href: '/imports/youtube', label: 'YouTube' },
    {
      id: '/imports/spotify-podcasts',
      href: '/imports/spotify-podcasts',
      label: 'Spotify podcasts',
    },
  ]
}
