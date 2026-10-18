/**
 * useTranscriptionSync - Hydrates and polls the transcription queue from the main process.
 *
 * Extracted from OperationController Phase 2+3A decomposition.
 * Runs a 5-second polling interval to reconcile the renderer-side
 * useTranscriptionStore with the database queue state.
 */

import { useEffect, useRef } from 'react'
import { useTranscriptionStore } from '@/store/features/useTranscriptionStore'

export function useTranscriptionSync() {
  const initializedRef = useRef(false)

  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    const isElectron = !!window.electronAPI?.recordings?.getTranscriptionQueue

    // Hydrate transcription queue from database on mount
    if (isElectron) {
      window.electronAPI.recordings.getTranscriptionQueue().then((items) => {
        useTranscriptionStore.getState().replaceFromPersistence(items)
      }).catch(e => console.error('Failed to hydrate transcription queue:', e))
    }

    // TQ-09 FIX: Subscribe to real-time transcription events instead of just polling
    const unsubscribers: (() => void)[] = []

    if (isElectron && window.electronAPI) {
      // Listen for transcription started
      if (window.electronAPI.onTranscriptionStarted) {
        unsubscribers.push(
          window.electronAPI.onTranscriptionStarted((data) => {
            const store = useTranscriptionStore.getState()
            if (data.queueItemId) {
              store.updateProgress(data.queueItemId, 0)
            }
          })
        )
      }

      // Listen for transcription progress
      if (window.electronAPI.onTranscriptionProgress) {
        unsubscribers.push(
          window.electronAPI.onTranscriptionProgress((data) => {
            const store = useTranscriptionStore.getState()
            if (data.queueItemId) {
              store.updateProgress(data.queueItemId, data.progress)
            }
          })
        )
      }

      // Listen for transcription completed
      if (window.electronAPI.onTranscriptionCompleted) {
        unsubscribers.push(
          window.electronAPI.onTranscriptionCompleted((data) => {
            const store = useTranscriptionStore.getState()
            if (data.queueItemId) {
              store.markCompleted(data.queueItemId, data.provider || 'gemini')
            }
          })
        )
      }

      // Listen for transcription failed
      if (window.electronAPI.onTranscriptionFailed) {
        unsubscribers.push(
          window.electronAPI.onTranscriptionFailed((data) => {
            const store = useTranscriptionStore.getState()
            if (data.queueItemId) {
              store.markFailed(data.queueItemId, data.error || 'Unknown error')
            }
          })
        )
      }

      // Listen for transcription cancelled
      if (window.electronAPI.onTranscriptionCancelled) {
        unsubscribers.push(
          window.electronAPI.onTranscriptionCancelled((data) => {
            const store = useTranscriptionStore.getState()
            // Find queue item by recordingId and remove it
            const items = Array.from(store.queue.values())
            const item = items.find((i) => i.recordingId === data.recordingId)
            if (item) {
              store.remove(item.id)
            }
          })
        )
      }

      // Listen for all transcriptions cancelled
      if (window.electronAPI.onTranscriptionAllCancelled) {
        unsubscribers.push(
          window.electronAPI.onTranscriptionAllCancelled(() => {
            const store = useTranscriptionStore.getState()
            store.clear()
          })
        )
      }
    }

    // Poll transcription queue and sync to store (5s interval)
    const transcriptionInterval = isElectron
      ? setInterval(async () => {
          try {
            if (!window.electronAPI.recordings.getTranscriptionQueue) return
            const items = await window.electronAPI.recordings.getTranscriptionQueue()
            if (!items) return

            useTranscriptionStore.getState().replaceFromPersistence(items)
          } catch {
            // Ignore polling errors
          }
        }, 5000)
      : null

    return () => {
      if (transcriptionInterval) clearInterval(transcriptionInterval)
      // TQ-09 FIX: Cleanup event listeners
      unsubscribers.forEach((unsub) => unsub())
    }
  }, [])
}
