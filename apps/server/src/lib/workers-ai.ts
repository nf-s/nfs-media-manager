import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { env } from '@/env'
import { ServerError } from './error'

export const AI_TEXT_MODEL = '@cf/openai/gpt-oss-120b'
export const AI_TRANSCRIPTION_MODEL = '@cf/openai/whisper-large-v3-turbo'
const timeoutMs = 60_000

export interface AiMessage {
  role: 'system' | 'user'
  content: string
}

export interface AiTextInput {
  messages: AiMessage[]
  response_format: { type: 'json_object' }
  reasoning_effort: 'high'
  max_tokens: number
  stream: false
  temperature: number
}

export interface AiTranscriptionInput {
  audio: string
  task: 'transcribe'
  vad_filter: true
  condition_on_previous_text: false
}

export interface WorkersAiTransport {
  text(input: AiTextInput, signal: AbortSignal): Promise<unknown>
  transcribe(input: AiTranscriptionInput, signal: AbortSignal): Promise<unknown>
}

const transports = new AsyncLocalStorage<WorkersAiTransport>()
const RestResponseSchema = z.object({
  success: z.literal(true),
  result: z.unknown().refine((value) => value !== undefined),
})

export function withWorkersAi<T>(
  transport: WorkersAiTransport,
  execute: () => T,
): T {
  return transports.run(transport, execute)
}

function nodeTransport(): WorkersAiTransport | undefined {
  const accountId = env.CLOUDFLARE_AI_ACCOUNT_ID
  const token = env.CLOUDFLARE_AI_API_TOKEN
  if (env.RUNTIME_KIND !== 'node' || !accountId || !token) return undefined

  async function request(
    model: typeof AI_TEXT_MODEL | typeof AI_TRANSCRIPTION_MODEL,
    input: AiTextInput | AiTranscriptionInput,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
        redirect: 'error',
        signal,
      },
    )
    if (!response.ok) throw new Error('AI request failed')
    return RestResponseSchema.parse(await response.json()).result
  }

  return {
    text: (input, signal) => request(AI_TEXT_MODEL, input, signal),
    transcribe: (input, signal) =>
      request(AI_TRANSCRIPTION_MODEL, input, signal),
  }
}

export function aiAvailable(): boolean {
  return Boolean(transports.getStore() ?? nodeTransport())
}

async function runInference(
  execute: (
    transport: WorkersAiTransport,
    signal: AbortSignal,
  ) => Promise<unknown>,
): Promise<unknown> {
  const transport = transports.getStore() ?? nodeTransport()
  if (!transport)
    throw new ServerError({
      statusCode: 503,
      message: 'Cloudflare AI is not configured.',
    })

  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new Error('AI request timed out'))
    }, timeoutMs)
  })

  try {
    return await Promise.race([execute(transport, controller.signal), timeout])
  } catch {
    throw new ServerError({
      statusCode: timedOut ? 504 : 502,
      message: timedOut
        ? 'Cloudflare AI took too long. Please try again.'
        : 'Cloudflare AI is unavailable. Please try again.',
    })
  } finally {
    clearTimeout(timer)
  }
}

export function runAiText(messages: AiMessage[]): Promise<unknown> {
  return runInference((transport, signal) =>
    transport.text(
      {
        messages,
        response_format: { type: 'json_object' },
        reasoning_effort: 'high',
        max_tokens: 8192,
        stream: false,
        temperature: 0,
      },
      signal,
    ),
  )
}

export function runAiTranscription(audio: string): Promise<unknown> {
  return runInference((transport, signal) =>
    transport.transcribe(
      {
        audio,
        task: 'transcribe',
        vad_filter: true,
        condition_on_previous_text: false,
      },
      signal,
    ),
  )
}
