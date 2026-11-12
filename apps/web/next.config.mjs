import { loadWorkspaceEnv } from './scripts/load-workspace-env.mjs'
import { assertPublicAssetsSafe } from './scripts/check-cloudflare-build.mjs'

if (process.env.WEB_RUNTIME !== 'cloudflare') {
  loadWorkspaceEnv(process.cwd())
}

if (process.env.WEB_RUNTIME === 'cloudflare') {
  await assertPublicAssetsSafe(process.cwd())
  if (process.env.NODE_ENV === 'development') {
    const { initOpenNextCloudflareForDev } =
      await import('@opennextjs/cloudflare')
    await initOpenNextCloudflareForDev()
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@repo/ui', '@repo/schemas'],
  output: 'standalone',
  productionBrowserSourceMaps: false,
}

export default nextConfig
