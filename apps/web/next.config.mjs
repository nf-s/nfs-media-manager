import { loadWorkspaceEnv } from './scripts/load-workspace-env.mjs'

loadWorkspaceEnv(process.cwd())

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@repo/ui', '@repo/schemas'],
  output: 'standalone',
}

export default nextConfig
