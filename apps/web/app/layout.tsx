import '@repo/ui/globals.css'
import type { Metadata } from 'next'
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
      </body>
    </html>
  )
}
