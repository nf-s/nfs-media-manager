import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeCloudJobMessage } from '@/services/cloud-job-queue'
import type { CloudJobCoordinatorClient } from '@/services/cloud-job-contract'

const mocks = vi.hoisted(() => ({ process: vi.fn(), recover: vi.fn() }))
vi.mock('@/services/jobs', () => ({ processQueuedJobById: mocks.process }))
vi.mock('@/services/cloud-job-store', () => ({
  recoverCloudJobById: mocks.recover,
}))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.process.mockResolvedValue(undefined)
  mocks.recover.mockResolvedValue(undefined)
})

function fixture() {
  const coordinator: CloudJobCoordinatorClient = {
    begin: vi.fn(async () => true),
    isActive: vi.fn(async () => true),
    recordOutcome: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
  }
  return {
    coordinator,
    coordinators: { getByName: vi.fn(() => coordinator) },
    message: {
      body: { version: 1, provider: 'fixture', jobId: 'job', token: 'token' },
      ack: vi.fn(),
      retry: vi.fn(),
    },
  }
}

describe('Queue consumer', () => {
  it('validates delivery before using its provider or touching the database', async () => {
    const f = fixture()
    await consumeCloudJobMessage(
      { ...f.message, body: { jobId: 'job' } },
      f.coordinators,
    )
    expect(f.message.ack).toHaveBeenCalledOnce()
    expect(f.coordinators.getByName).not.toHaveBeenCalled()
    expect(mocks.process).not.toHaveBeenCalled()
  })

  it('acknowledges duplicates without releasing the original running slot', async () => {
    const f = fixture()
    f.coordinator.begin = vi.fn(async () => false)
    await consumeCloudJobMessage(f.message, f.coordinators)
    expect(f.message.ack).toHaveBeenCalledOnce()
    expect(mocks.process).not.toHaveBeenCalled()
    expect(f.coordinator.finish).not.toHaveBeenCalled()
  })

  it('processes the matching provider and finishes before acknowledgement', async () => {
    const f = fixture()
    f.coordinator.finish = vi.fn(async () => {
      expect(f.message.ack).not.toHaveBeenCalled()
    })
    await consumeCloudJobMessage(f.message, f.coordinators)
    expect(mocks.process).toHaveBeenCalledWith(
      'job',
      'fixture',
      expect.objectContaining({
        canContinue: expect.any(Function),
        recordOutcome: expect.any(Function),
      }),
    )
    expect(f.coordinator.finish).toHaveBeenCalledOnce()
    expect(f.message.ack).toHaveBeenCalledOnce()
  })

  it('fails interrupted work rather than replaying the provider', async () => {
    const f = fixture()
    mocks.process.mockRejectedValue(new Error('Persistence failed'))
    await consumeCloudJobMessage(f.message, f.coordinators)
    expect(mocks.recover).toHaveBeenCalledWith('job', 'fixture')
    expect(mocks.process).toHaveBeenCalledOnce()
    expect(f.message.ack).toHaveBeenCalledOnce()
  })

  it('leaves durable ownership intact if recovery fails', async () => {
    const f = fixture()
    mocks.process.mockRejectedValue(new Error('Database unavailable'))
    mocks.recover.mockRejectedValue(new Error('Database unavailable'))
    await consumeCloudJobMessage(f.message, f.coordinators)
    expect(f.message.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
    expect(f.message.ack).not.toHaveBeenCalled()
    expect(f.coordinator.finish).not.toHaveBeenCalled()
  })

  it('retries transport failures without calling the provider', async () => {
    const f = fixture()
    f.coordinator.begin = vi.fn(async () => {
      throw new Error('DO unavailable')
    })
    await consumeCloudJobMessage(f.message, f.coordinators)
    expect(f.message.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
    expect(mocks.process).not.toHaveBeenCalled()
  })
})
