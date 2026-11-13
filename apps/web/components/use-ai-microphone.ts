'use client'

import { useEffect, useRef, useState } from 'react'
import {
  captureRecording,
  chooseRecordingMimeType,
  microphoneErrorMessage,
} from '@/utils/ai-recording'

export function useAiMicrophone(onAudio: (audio: Blob) => void) {
  const [phase, setPhase] = useState<'idle' | 'requesting' | 'recording'>(
    'idle',
  )
  const [error, setError] = useState('')
  const generation = useRef(0)
  const active = useRef(false)
  const capture = useRef<ReturnType<typeof captureRecording> | null>(null)
  const complete = useRef(onAudio)
  complete.current = onAudio

  useEffect(
    () => () => {
      generation.current += 1
      active.current = false
      capture.current?.cancel()
      capture.current = null
    },
    [],
  )

  function cancel() {
    generation.current += 1
    active.current = false
    capture.current?.cancel()
    capture.current = null
    setPhase('idle')
  }

  async function start() {
    if (active.current) return
    setError('')
    if (!window.isSecureContext) {
      setError(
        'Microphone recording requires HTTPS or localhost. You can still type your request.',
      )
      return
    }
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === 'undefined'
    ) {
      setError(
        'This browser does not support microphone recording. Use another browser or type your request.',
      )
      return
    }
    const mimeType = chooseRecordingMimeType((type) =>
      MediaRecorder.isTypeSupported(type),
    )
    if (!mimeType) {
      setError(
        'This browser does not support a compatible recording format. You can still type your request.',
      )
      return
    }
    active.current = true
    const request = ++generation.current
    setPhase('requesting')
    let stream: MediaStream | undefined
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (request !== generation.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      const tracks = stream.getTracks()
      const recorder = new MediaRecorder(stream, {
        mimeType,
        audioBitsPerSecond: 128000,
      })
      let unsubscribe = () => {}
      setPhase('recording')
      capture.current = captureRecording(
        {
          start: (events) => {
            const data = (event: BlobEvent) => events.data(event.data)
            const stopped = () => events.stopped()
            const failed = () => events.failed()
            recorder.addEventListener('dataavailable', data)
            recorder.addEventListener('stop', stopped)
            recorder.addEventListener('error', failed)
            unsubscribe = () => {
              recorder.removeEventListener('dataavailable', data)
              recorder.removeEventListener('stop', stopped)
              recorder.removeEventListener('error', failed)
            }
            recorder.start(250)
          },
          stop: () => {
            if (recorder.state !== 'inactive') recorder.stop()
            tracks.forEach((track) => track.stop())
          },
          dispose: () => {
            unsubscribe()
            tracks.forEach((track) => track.stop())
          },
          mimeType: () => recorder.mimeType || mimeType,
        },
        {
          complete: (audio) => {
            if (request !== generation.current) return
            active.current = false
            capture.current = null
            setPhase('idle')
            complete.current(audio)
          },
          failed: (message) => {
            if (request !== generation.current) return
            active.current = false
            capture.current = null
            setPhase('idle')
            setError(message)
          },
        },
      )
    } catch (failure) {
      stream?.getTracks().forEach((track) => track.stop())
      if (request !== generation.current) return
      active.current = false
      setPhase('idle')
      setError(microphoneErrorMessage(failure))
    }
  }

  return {
    phase,
    error,
    start,
    stop: () => capture.current?.stop(),
    cancel,
    clearError: () => setError(''),
  }
}
