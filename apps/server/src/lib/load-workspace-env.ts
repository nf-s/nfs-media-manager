import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { config } from 'dotenv'

export function findWorkspaceFilePath(
  startDirectory: string,
  filename: string,
): string | null {
  let currentDirectory = resolve(startDirectory)

  while (true) {
    const candidatePath = join(currentDirectory, filename)

    if (existsSync(candidatePath)) {
      return candidatePath
    }

    const parentDirectory = dirname(currentDirectory)

    if (parentDirectory === currentDirectory) {
      return null
    }

    currentDirectory = parentDirectory
  }
}

export function findWorkspaceEnvPath(
  startDirectory: string,
): string | null {
  return findWorkspaceFilePath(startDirectory, '.env')
}

export function findWorkspaceRootPath(
  startDirectory: string,
): string | null {
  const envPath = findWorkspaceEnvPath(startDirectory)

  if (!envPath) {
    return null
  }

  return dirname(envPath)
}

export function loadWorkspaceEnv(startDirectory: string = process.cwd()): void {
  const envPath = findWorkspaceFilePath(startDirectory, '.env')
  const envLocalPath = findWorkspaceFilePath(startDirectory, '.env.local')

  if (envPath) {
    config({ path: envPath, quiet: true })
  }

  if (envLocalPath) {
    config({ path: envLocalPath, override: true, quiet: true })
  }
}
