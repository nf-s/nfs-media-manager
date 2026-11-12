import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'NFS Media',
    short_name: 'NFS Media',
    description: 'Media library',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#e9ecf0',
    theme_color: '#e9ecf0',
    icons: [
      {
        src: '/icons/app/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/app/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  }
}
