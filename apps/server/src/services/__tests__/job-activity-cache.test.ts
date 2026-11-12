import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  jobs: vi.fn(),
  imports: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  db: {
    execute: mocks.execute,
    select: (selection: object) => ({
      from: () => ('queued' in selection ? mocks.jobs() : mocks.imports()),
    }),
  },
}))

let version = '100:100:'
beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  version = '100:100:'
  mocks.execute.mockImplementation(async () => ({
    rows: [
      {
        version,
        database: 'fixture',
        role: 'fixture',
        schemas: '{public}',
      },
    ],
  }))
  mocks.jobs.mockResolvedValue([
    { queued: 3, running: 1, completed: 10, failed: 2 },
  ])
  mocks.imports.mockResolvedValue([{ count: 1, completed: 5 }])
})

describe('job activity read cache', () => {
  it('reuses counts only while the database snapshot stays unchanged', async () => {
    const { getJobActivity } = await import('@/services/jobs')
    const first = await getJobActivity()
    expect(await getJobActivity()).toEqual(first)
    expect(first).toMatchObject({
      queued: 3,
      running: 1,
      completed: 10,
      imports: 1,
    })
    expect(mocks.jobs).toHaveBeenCalledOnce()
    expect(mocks.imports).toHaveBeenCalledOnce()
    version = '101:101:'
    mocks.jobs.mockResolvedValue([
      { queued: 2, running: 2, completed: 10, failed: 2 },
    ])
    expect(await getJobActivity()).toMatchObject({ queued: 2, running: 2 })
    expect(mocks.jobs).toHaveBeenCalledTimes(2)
  })

  it('does not cache across a commit during the aggregate reads', async () => {
    const { getJobActivity } = await import('@/services/jobs')
    mocks.jobs.mockImplementation(async () => {
      version = '101:101:'
      return [{ queued: 1 }]
    })
    await getJobActivity()
    await getJobActivity()
    expect(mocks.jobs).toHaveBeenCalledTimes(2)
  })
})
