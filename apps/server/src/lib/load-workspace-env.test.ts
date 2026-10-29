import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findWorkspaceEnvPath,
  findWorkspaceFilePath,
  loadWorkspaceEnv,
} from '@/lib/load-workspace-env'

const environmentKey = 'LOAD_WORKSPACE_ENV_TEST_KEY'

afterEach(() => {
  delete process.env[environmentKey]
})

function createTempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'media-manager-env-'))
}

describe('findWorkspaceEnvPath', () => {
  it('finds the nearest workspace env file from a nested package directory', () => {
    const workspaceDirectory = createTempWorkspace()
    const nestedDirectory = join(workspaceDirectory, 'apps', 'server')

    writeFileSync(join(workspaceDirectory, '.env'), 'TEST_KEY=value\n')

    expect(findWorkspaceEnvPath(nestedDirectory)).toBe(
      join(workspaceDirectory, '.env'),
    )

    rmSync(workspaceDirectory, { recursive: true, force: true })
  })

  it('finds an env.local file from a nested package directory', () => {
    const workspaceDirectory = createTempWorkspace()
    const nestedDirectory = join(workspaceDirectory, 'apps', 'server')

    writeFileSync(join(workspaceDirectory, '.env.local'), 'TEST_KEY=value\n')

    expect(findWorkspaceFilePath(nestedDirectory, '.env.local')).toBe(
      join(workspaceDirectory, '.env.local'),
    )

    rmSync(workspaceDirectory, { recursive: true, force: true })
  })

  it('loads the discovered env file without overriding an existing value', () => {
    const workspaceDirectory = createTempWorkspace()
    const nestedDirectory = join(workspaceDirectory, 'apps', 'server')

    writeFileSync(
      join(workspaceDirectory, '.env'),
      `${environmentKey}=loaded-from-env\n`,
    )

    loadWorkspaceEnv(nestedDirectory)

    expect(process.env[environmentKey]).toBe('loaded-from-env')

    process.env[environmentKey] = 'already-set'
    loadWorkspaceEnv(nestedDirectory)

    expect(process.env[environmentKey]).toBe('already-set')

    rmSync(workspaceDirectory, { recursive: true, force: true })
  })

  it('lets env.local override values from env', () => {
    const workspaceDirectory = createTempWorkspace()
    const nestedDirectory = join(workspaceDirectory, 'apps', 'server')

    writeFileSync(
      join(workspaceDirectory, '.env'),
      `${environmentKey}=loaded-from-env\n`,
    )
    writeFileSync(
      join(workspaceDirectory, '.env.local'),
      `${environmentKey}=loaded-from-env-local\n`,
    )

    loadWorkspaceEnv(nestedDirectory)

    expect(process.env[environmentKey]).toBe('loaded-from-env-local')

    rmSync(workspaceDirectory, { recursive: true, force: true })
  })
})
