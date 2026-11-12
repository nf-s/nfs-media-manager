import { z } from 'zod'

export const CloudJobMessageSchema = z
  .object({
    version: z.literal(1),
    provider: z.string().min(1).max(200),
    jobId: z.string().min(1).max(200),
    token: z.string().min(1).max(200),
  })
  .strict()

export type CloudJobMessage = z.infer<typeof CloudJobMessageSchema>
export const CloudJobOutcomeSchema = z.enum(['success', 'failure', 'stopped'])
export type CloudJobOutcome = z.infer<typeof CloudJobOutcomeSchema>

export interface CloudJobCoordinatorClient {
  begin(message: CloudJobMessage): Promise<boolean>
  isActive(message: CloudJobMessage): Promise<boolean>
  recordOutcome(
    message: CloudJobMessage,
    outcome: CloudJobOutcome,
  ): Promise<void>
  finish(message: CloudJobMessage): Promise<void>
}

export interface CloudJobCoordinators {
  getByName(provider: string): CloudJobCoordinatorClient
}
