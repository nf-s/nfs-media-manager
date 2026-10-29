import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { config as loadDotenv } from 'dotenv'

function findWorkspaceFilePath(startDirectory, filename) {
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

export function loadWorkspaceEnv(startDirectory = process.cwd()) {
  const envPath = findWorkspaceFilePath(startDirectory, '.env')
  const envLocalPath = findWorkspaceFilePath(startDirectory, '.env.local')

  if (envPath) {
    loadDotenv({ path: envPath, quiet: true })
  }

  if (envLocalPath) {
    loadDotenv({ path: envLocalPath, override: true, quiet: true })
  }
}
