import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AI_TEXT_MODEL,
  AI_TRANSCRIPTION_MODEL,
  aiAvailable,
  runAiText,
  runAiTranscription,
  withWorkersAi,
  type AiMessage,
  type WorkersAiTransport,
} from './workers-ai'

const settings = vi.hoisted(
  (): {
    RUNTIME_KIND: string
    CLOUDFLARE_AI_ACCOUNT_ID: string | undefined
    CLOUDFLARE_AI_API_TOKEN: string | undefined
  } => ({
    RUNTIME_KIND: 'node',
    CLOUDFLARE_AI_ACCOUNT_ID: undefined,
    CLOUDFLARE_AI_API_TOKEN: undefined,
  }),
)
vi.mock('@/env', () => ({ env: settings }))

const messages: AiMessage[] = [
  { role: 'system', content: 'Return a JSON search plan.' },
  { role: 'user', content: 'Show rock albums.' },
]

beforeEach(() => {
  settings.RUNTIME_KIND = 'node'
  settings.CLOUDFLARE_AI_ACCOUNT_ID = undefined
  settings.CLOUDFLARE_AI_API_TOKEN = undefined
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function mockTransport(): WorkersAiTransport {
  return {
    text: vi.fn().mockResolvedValue({ choices: [] }),
    transcribe: vi.fn().mockResolvedValue({ text: 'Show rock albums.' }),
  }
}

describe('Workers AI transport', () => {
  it('fails clearly without an AI binding or explicitly configured Node credentials', async () => {
    expect(aiAvailable()).toBe(false)
    await expect(runAiText(messages)).rejects.toMatchObject({
      response: {
        statusCode: 503,
        message: 'Cloudflare AI is not configured.',
      },
    })
  })

  it('passes bounded JSON generation and transcription options to the binding', async () => {
    const transport = mockTransport()
    await withWorkersAi(transport, async () => {
      expect(aiAvailable()).toBe(true)
      await runAiText(messages)
      expect(transport.text).toHaveBeenCalledWith(
        {
          messages,
          response_format: { type: 'json_object' },
          reasoning_effort: 'high',
          max_tokens: 8192,
          stream: false,
          temperature: 0,
        },
        expect.any(AbortSignal),
      )
      await runAiTranscription('c3ludGhldGljIGF1ZGlv')
      expect(transport.transcribe).toHaveBeenCalledWith(
        {
          audio: 'c3ludGhldGljIGF1ZGlv',
          task: 'transcribe',
          vad_filter: true,
          condition_on_previous_text: false,
        },
        expect.any(AbortSignal),
      )
    })
    expect(aiAvailable()).toBe(false)
  })

  it('keeps concurrent request transports isolated', async () => {
    const first = mockTransport()
    const second = mockTransport()
    await Promise.all([
      withWorkersAi(first, async () => {
        await Promise.resolve()
        await runAiText(messages)
      }),
      withWorkersAi(second, async () => {
        await Promise.resolve()
        await runAiTranscription('c3ludGhldGljIGF1ZGlv')
      }),
    ])
    expect(first.text).toHaveBeenCalledOnce()
    expect(first.transcribe).not.toHaveBeenCalled()
    expect(second.transcribe).toHaveBeenCalledOnce()
    expect(second.text).not.toHaveBeenCalled()
  })

  it('aborts and bounds an unresponsive inference without retrying', async () => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | undefined
    const text = vi.fn((_input: unknown, signal: AbortSignal) => {
      requestSignal = signal
      return new Promise<unknown>(() => {})
    })
    const pending = withWorkersAi({ ...mockTransport(), text }, () =>
      runAiText(messages),
    )
    const rejected = expect(pending).rejects.toMatchObject({
      response: {
        statusCode: 504,
        message: 'Cloudflare AI took too long. Please try again.',
      },
    })
    await vi.advanceTimersByTimeAsync(60_000)
    await rejected
    expect(requestSignal?.aborted).toBe(true)
    expect(text).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sanitizes upstream failures and clears the timeout', async () => {
    vi.useFakeTimers()
    const text = vi.fn().mockRejectedValue(new Error('Sensitive upstream body'))
    await expect(
      withWorkersAi({ ...mockTransport(), text }, () => runAiText(messages)),
    ).rejects.toMatchObject({
      response: {
        statusCode: 502,
        message: 'Cloudflare AI is unavailable. Please try again.',
        data: null,
      },
    })
    expect(text).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the configured Node REST endpoint and unwraps its validated envelope', async () => {
    settings.CLOUDFLARE_AI_ACCOUNT_ID = '0'.repeat(32)
    settings.CLOUDFLARE_AI_API_TOKEN = 'synthetic-test-token'
    const fetch = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ success: true, result: { text: 'Show rock albums.' } }),
      )
    vi.stubGlobal('fetch', fetch)
    expect(aiAvailable()).toBe(true)
    expect(await runAiTranscription('c3ludGhldGljIGF1ZGlv')).toEqual({
      text: 'Show rock albums.',
    })
    expect(fetch).toHaveBeenCalledWith(
      `https://api.cloudflare.com/client/v4/accounts/${'0'.repeat(32)}/ai/run/${AI_TRANSCRIPTION_MODEL}`,
      expect.objectContaining({ method: 'POST', redirect: 'error' }),
    )
    await runAiText(messages)
    expect(fetch).toHaveBeenLastCalledWith(
      `https://api.cloudflare.com/client/v4/accounts/${'0'.repeat(32)}/ai/run/${AI_TEXT_MODEL}`,
      expect.objectContaining({ method: 'POST', redirect: 'error' }),
    )
  })

  it('prefers the binding and does not use REST credentials in Cloudflare runtime', async () => {
    settings.CLOUDFLARE_AI_ACCOUNT_ID = '0'.repeat(32)
    settings.CLOUDFLARE_AI_API_TOKEN = 'synthetic-test-token'
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const transport = mockTransport()
    await withWorkersAi(transport, () => runAiText(messages))
    expect(transport.text).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()

    settings.RUNTIME_KIND = 'cloudflare'
    expect(aiAvailable()).toBe(false)
    await expect(runAiText(messages)).rejects.toMatchObject({
      response: { statusCode: 503 },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    { success: false, result: { text: 'Invalid result' } },
    { success: true },
  ])('rejects unsuccessful or malformed REST envelopes', async (body) => {
    settings.CLOUDFLARE_AI_ACCOUNT_ID = '0'.repeat(32)
    settings.CLOUDFLARE_AI_API_TOKEN = 'synthetic-test-token'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)))
    await expect(runAiText(messages)).rejects.toMatchObject({
      response: { statusCode: 502, data: null },
    })
  })
})
