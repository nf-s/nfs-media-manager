import {
  CloudJobMessageSchema,
  type CloudJobCoordinators,
} from '@/services/cloud-job-contract'
import { processQueuedJobById } from '@/services/jobs'
import { recoverCloudJobById } from '@/services/cloud-job-store'

export interface CloudQueueMessage {
  body: unknown
  ack(): void
  retry(options: { delaySeconds: number }): void
}

// Call inside the invocation's DB context. Infrastructure redelivery never
// reruns a running/terminal job; expired claims are recovered by the DO alarm.
export async function consumeCloudJobMessage(
  message: CloudQueueMessage,
  coordinators: CloudJobCoordinators,
): Promise<void> {
  const parsed = CloudJobMessageSchema.safeParse(message.body)
  if (!parsed.success) {
    message.ack()
    return
  }
  const body = parsed.data
  const coordinator = coordinators.getByName(body.provider)
  try {
    if (!(await coordinator.begin(body))) {
      message.ack()
      return
    }
    try {
      await processQueuedJobById(body.jobId, body.provider, {
        canContinue: () => coordinator.isActive(body),
        recordOutcome: (outcome) => coordinator.recordOutcome(body, outcome),
      })
    } catch {
      // processJob has already awaited all provider I/O before rejecting.
      // Fail closed, preserving the original ID and all committed results.
      await recoverCloudJobById(body.jobId, body.provider)
    }
    await coordinator.finish(body)
    message.ack()
  } catch {
    message.retry({ delaySeconds: 30 })
  }
}
