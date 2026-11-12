import '@repo/ui/globals.css'
import type { Metadata, Viewport } from 'next'
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google'
import Providers from '@/components/providers'
import { env, getApiBaseUrl } from '@/env'

const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex-sans',
})

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
})

export const metadata: Metadata = {
  title: 'NFS Media Manager',
  description: 'Media library',
  applicationName: 'NFS Media',
  appleWebApp: {
    capable: true,
    title: 'NFS Media',
    statusBarStyle: 'default',
  },
  icons: {
    icon: {
      url: '/icons/app/icon-192.png',
      sizes: '192x192',
      type: 'image/png',
    },
    apple: {
      url: '/icons/app/apple-touch-icon.png',
      sizes: '180x180',
      type: 'image/png',
    },
  },
}

export const viewport: Viewport = {
  themeColor: '#e9ecf0',
}

// Note: Need to be force-dynamic to get the correct env variables at runtime
export const dynamic = 'force-dynamic'

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body
        className={`${plexSans.variable} ${plexMono.variable} min-h-screen font-[family-name:var(--font-plex-sans)]`}
      >
        <Providers appUrl={env.APP_URL ?? ''} apiBaseUrl={getApiBaseUrl()}>
          {children}
        </Providers>
        {env.CLOUDFLARE_WEB_ANALYTICS_TOKEN && (
          <script
            defer
            src="https://static.cloudflareinsights.com/beacon.min.js"
            data-cf-beacon={JSON.stringify({
              token: env.CLOUDFLARE_WEB_ANALYTICS_TOKEN,
            })}
          />
        )}
      </body>
    </html>
  )
}
