import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { config, parse } from 'dotenv'

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

export function findWorkspaceEnvPath(startDirectory: string): string | null {
  return findWorkspaceFilePath(startDirectory, '.env')
}

export function findWorkspaceRootPath(startDirectory: string): string | null {
  const envPath = findWorkspaceEnvPath(startDirectory)

  if (!envPath) {
    return null
  }

  return dirname(envPath)
}

/**
 * Names one env file that replaces the workspace `.env` and `.env.local`, so a
 * process such as the preview can run on its own settings without reading the
 * local ones.
 */
export const workspaceEnvFileKey = 'MEDIA_MANAGER_ENV_FILE'

/** The workspace `.env` values with `.env.local` over them, without loading them. */
export function readWorkspaceEnv(
  startDirectory: string = process.cwd(),
): Record<string, string> {
  const envPath = findWorkspaceFilePath(startDirectory, '.env')
  const envLocalPath = findWorkspaceFilePath(startDirectory, '.env.local')

  return {
    ...(envPath ? parse(readFileSync(envPath)) : {}),
    ...(envLocalPath ? parse(readFileSync(envLocalPath)) : {}),
  }
}

export function loadWorkspaceEnv(startDirectory: string = process.cwd()): void {
  const replacementPath = process.env[workspaceEnvFileKey]

  if (replacementPath) {
    config({ path: replacementPath, override: true, quiet: true })
    return
  }

  const envPath = findWorkspaceFilePath(startDirectory, '.env')
  const envLocalPath = findWorkspaceFilePath(startDirectory, '.env.local')

  if (envPath) {
    config({ path: envPath, quiet: true })
  }

  if (envLocalPath) {
    config({ path: envLocalPath, override: true, quiet: true })
  }
}
