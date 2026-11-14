import {
  CloudDispatchControlSchema,
  type CloudDispatchStatus,
} from '@repo/schemas/job'

export type ProviderDispatchAction = 'resume' | 'resume-all' | 'pause'

export function createProviderDispatchInput(
  action: ProviderDispatchAction,
  status: Pick<CloudDispatchStatus, 'allowedJobIds'>,
) {
  return CloudDispatchControlSchema.parse({
    paused: action === 'pause',
    ...(action === 'pause'
      ? {}
      : { jobIds: action === 'resume-all' ? null : status.allowedJobIds }),
  })
}
