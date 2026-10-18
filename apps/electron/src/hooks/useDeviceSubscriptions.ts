/**
 * useDeviceSubscriptions - Device state/status/activity subscriptions and auto-sync trigger.
 *
 * Extracted from OperationController Phase 2+3A decomposition.
 * Owns: device state/status subscriptions, activity log forwarding,
 * auto-sync on device ready, and initial auto-sync for pre-connected devices.
 */

import { useEffect, useRef } from 'react'
import { getHiDockDeviceService } from '@/services/hidock-device'
import { useAppStore } from '@/store/useAppStore'
import { shouldLogQa } from '@/services/qa-monitor'
import { checkAutoSyncAllowed, waitForConfig, waitForDeviceReady } from '@/utils/autoSyncGuard'
import { getStableDeviceId } from '@/utils/deviceIdentity'

const MAX_AUTOMATIC_SYNC_FILES = 20

type DeviceService = ReturnType<typeof getHiDockDeviceService>

interface SafeAutoSyncResult {
  queued: number
  baselineInitialized: boolean
  reason?: string
}

/**
 * Observe the connected device and queue only recordings that are explicitly in
 * its durable Review queue. The first observation creates a baseline and queues
 * nothing, even when the device contains a large historical archive.
 */
export async function startSafeAutoSync(
  deviceService: DeviceService,
  setDeviceSyncState: (state: {
    deviceSyncing: boolean
    deviceSyncProgress: { total: number; current: number }
    deviceFileDownloading: string | null
  }) => void
): Promise<SafeAutoSyncResult> {
  const deviceId = getStableDeviceId(deviceService)
  if (!deviceId) {
    deviceService.log('warning', 'Auto-sync paused', 'Could not establish a stable device identity')
    return { queued: 0, baselineInitialized: false, reason: 'device-identity-unavailable' }
  }

  if (!window.electronAPI?.deviceIngestion || !window.electronAPI?.downloadService) {
    deviceService.log('warning', 'Auto-sync paused', 'The safe review-queue service is unavailable')
    return { queued: 0, baselineInitialized: false, reason: 'review-service-unavailable' }
  }

  const recordings = deviceService.getCachedRecordings()
  if (recordings.length === 0) {
    return { queued: 0, baselineInitialized: false, reason: 'empty-device-inventory' }
  }

  const observation = await window.electronAPI.deviceIngestion.observeInventory({
    deviceId,
    files: recordings.map((recording) => ({
      filename: recording.filename,
      fileSize: recording.size ?? 0,
      recordedAt: recording.dateCreated?.toISOString() ?? null
    }))
  })

  if (observation.baselineInitialized) {
    deviceService.log(
      'info',
      'Auto-sync baseline created',
      `${recordings.length} existing recordings were left on the device for manual review`
    )
  }

  const pendingFilenames = new Set(observation.pendingItems.map((item) => item.filename))
  const pendingRecordingsWithUnknownDates = recordings.filter(
    (recording) => pendingFilenames.has(recording.filename) && !recording.dateCreated
  )
  const pendingRecordings = recordings.filter(
    (recording) => pendingFilenames.has(recording.filename) && recording.dateCreated
  )
  if (pendingRecordingsWithUnknownDates.length > 0) {
    deviceService.log(
      'warning',
      'Auto-sync paused for undated recordings',
      `${pendingRecordingsWithUnknownDates.length} recording${pendingRecordingsWithUnknownDates.length > 1 ? 's need' : ' needs'} an original date before download`
    )
  }
  if (pendingRecordings.length === 0) {
    return {
      queued: 0,
      baselineInitialized: observation.baselineInitialized,
      reason: pendingRecordingsWithUnknownDates.length > 0 ? 'source-date-unknown' : 'no-new-review-items'
    }
  }

  if (pendingRecordings.length > MAX_AUTOMATIC_SYNC_FILES) {
    deviceService.log(
      'warning',
      'Auto-sync paused',
      `${pendingRecordings.length} new recordings require manual selection to prevent an unexpected bulk download`
    )
    return { queued: 0, baselineInitialized: observation.baselineInitialized, reason: 'automatic-limit-exceeded' }
  }

  const reconcileResults = await window.electronAPI.downloadService.getFilesToSync(
    pendingRecordings.map((recording) => ({
      filename: recording.filename,
      size: recording.size,
      duration: recording.duration,
      dateCreated: recording.dateCreated
    }))
  )
  const toSync = reconcileResults.filter((result) => !result.skipReason)
  if (toSync.length === 0) {
    deviceService.log('success', 'Review queue synced', 'No new review recordings need downloading')
    return { queued: 0, baselineInitialized: observation.baselineInitialized, reason: 'already-synced' }
  }

  const filesToQueue = toSync.map((recording) => ({
    filename: recording.filename,
    size: recording.size,
    dateCreated: recording.dateCreated?.toISOString()
  }))
  await window.electronAPI.downloadService.startSession(filesToQueue)
  await Promise.allSettled(toSync.map((recording) => (
    window.electronAPI.deviceIngestion.updateReviewStatus({
      deviceId,
      filename: recording.filename,
      status: 'approved'
    })
  )))

  if (shouldLogQa()) {
    console.log(`[QA-MONITOR][Operation] Safe auto-sync: ${toSync.length} reviewed files queued`)
  }
  deviceService.log('info', 'Auto-sync triggered', `${toSync.length} new review recordings queued for download`)
  setDeviceSyncState({
    deviceSyncing: true,
    deviceSyncProgress: { total: toSync.length, current: 0 },
    deviceFileDownloading: toSync[0]?.filename ?? null
  })

  return { queued: toSync.length, baselineInitialized: observation.baselineInitialized }
}

export function useDeviceSubscriptions() {
  const deviceService = getHiDockDeviceService()
  const deviceSubscriptionsInitialized = useRef(false)
  const autoSyncTriggeredRef = useRef(false)
  const syncDebounceTimerRef = useRef<NodeJS.Timeout | null>(null) // spec-007: debounce timer

  const setDeviceState = useAppStore((s) => s.setDeviceState)
  const setConnectionStatus = useAppStore((s) => s.setConnectionStatus)
  const addActivityLogEntry = useAppStore((s) => s.addActivityLogEntry)
  const setDeviceSyncState = useAppStore((s) => s.setDeviceSyncState)

  // SM-M02: Use refs for store actions to prevent stale closures in long-lived subscriptions.
  // The deviceSubscriptionsInitialized guard means the effect won't re-run when these
  // action references change, so storing them in refs ensures the callbacks always use
  // the latest function reference.
  const setDeviceStateRef = useRef(setDeviceState)
  setDeviceStateRef.current = setDeviceState
  const setConnectionStatusRef = useRef(setConnectionStatus)
  setConnectionStatusRef.current = setConnectionStatus
  const addActivityLogEntryRef = useRef(addActivityLogEntry)
  addActivityLogEntryRef.current = addActivityLogEntry
  const setDeviceSyncStateRef = useRef(setDeviceSyncState)
  setDeviceSyncStateRef.current = setDeviceSyncState

  // ---- Device state subscriptions (guarded for single subscription) ----

  useEffect(() => {
    if (deviceSubscriptionsInitialized.current) return
    deviceSubscriptionsInitialized.current = true

    if (shouldLogQa()) console.log('[useDeviceSubscriptions] Subscribing to device state')

    // Get initial device state and update store
    const initialState = deviceService.getState()
    const initialStatus = deviceService.getConnectionStatus()
    setDeviceStateRef.current(initialState)
    setConnectionStatusRef.current(initialStatus)

    // Subscribe to device state changes
    const unsubStateChange = deviceService.onStateChange((state) => {
      if (shouldLogQa()) console.log('[useDeviceSubscriptions] Device state changed:', state)
      setDeviceStateRef.current(state)
    })

    // Subscribe to connection status changes
    const unsubStatusChange = deviceService.onStatusChange(async (status) => {
      if (shouldLogQa()) console.log('[useDeviceSubscriptions] Connection status changed:', status)
      setConnectionStatusRef.current(status)

      // DL-008: 'disconnected' is not a valid ConnectionStep — device goes to 'idle' on disconnect
      if (status.step === 'idle' && !deviceService.isConnected() && window.electronAPI?.downloadService) {
        const cancelled = await window.electronAPI.downloadService.cancelActive('Device disconnected')
        if (cancelled > 0) {
          if (shouldLogQa()) console.log(`[useDeviceSubscriptions] Cancelled ${cancelled} downloads due to disconnect`)
          deviceService.log('info', 'Downloads cancelled', `${cancelled} active downloads cancelled due to disconnect`)
        }
      }

      // AUTO-SYNC TRIGGER: Only when status becomes 'ready'
      if (status.step !== 'ready') return
      if (autoSyncTriggeredRef.current) return

      const { allowed, reason } = checkAutoSyncAllowed()
      if (!allowed) {
        if (shouldLogQa()) console.log(`[useDeviceSubscriptions] Auto-sync skipped on ready: ${reason}`)
        return
      }

      // spec-007: Clear existing debounce timer
      if (syncDebounceTimerRef.current) {
        clearTimeout(syncDebounceTimerRef.current)
        if (shouldLogQa()) console.log('[useDeviceSubscriptions] Cleared previous sync debounce timer')
      }

      // spec-007: Debounce sync by 2 seconds
      syncDebounceTimerRef.current = setTimeout(async () => {
        try {
          autoSyncTriggeredRef.current = true
          if (shouldLogQa()) console.log('[useDeviceSubscriptions] Auto-sync triggered after 2s debounce')

          await startSafeAutoSync(deviceService, setDeviceSyncStateRef.current)
        } catch (error) {
          console.error('[useDeviceSubscriptions] Auto-sync failed:', error)
        } finally {
          syncDebounceTimerRef.current = null
        }
      }, 2000) // spec-007: 2 second debounce
    })

    // Subscribe to activity log (renderer-side: device service events)
    const unsubActivity = deviceService.onActivity((entry) => {
      addActivityLogEntryRef.current(entry)
    })

    // Subscribe to activity log (main-process bridge: transcription, calendar, download)
    // These services run in the main process and cannot call deviceService.log() directly.
    let unsubMainActivity: (() => void) | null = null
    if (window.electronAPI?.onActivityLogEntry) {
      unsubMainActivity = window.electronAPI.onActivityLogEntry((entry) => {
        addActivityLogEntryRef.current({
          type: entry.type as any,
          message: entry.message,
          details: entry.details,
          timestamp: new Date(entry.timestamp)
        })
      })
    }

    return () => {
      if (shouldLogQa()) console.log('[useDeviceSubscriptions] Unsubscribing from device state')
      // spec-007: Clear debounce timer on cleanup
      if (syncDebounceTimerRef.current) {
        clearTimeout(syncDebounceTimerRef.current)
        syncDebounceTimerRef.current = null
      }
      unsubStateChange()
      unsubStatusChange()
      unsubActivity()
      unsubMainActivity?.()
      // SM-001: Do NOT reset deviceSubscriptionsInitialized.current here.
      // StrictMode does mount → cleanup → mount; resetting allows double subscription.
      // When the component truly unmounts and remounts, React creates a NEW ref(false).
    }
  // SM-M02: Dependencies are stable (deviceService is singleton), refs handle action freshness
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceService])

  // ---- Initial auto-sync for pre-connected devices ----

  useEffect(() => {
    const isElectron = !!window.electronAPI?.downloadService

    const checkInitialAutoSync = async () => {
      if (!isElectron) return

      const configLoaded = await waitForConfig(10000)
      if (!configLoaded) {
        if (shouldLogQa()) console.log('[useDeviceSubscriptions] Config load timeout, skipping auto-sync')
        return
      }

      const deviceReady = await waitForDeviceReady(60000)
      if (!deviceReady) {
        if (shouldLogQa()) console.log('[useDeviceSubscriptions] Device not ready, skipping auto-sync')
        return
      }

      const { allowed, reason } = checkAutoSyncAllowed()
      if (!allowed) {
        if (shouldLogQa()) console.log(`[useDeviceSubscriptions] Auto-sync skipped: ${reason}`)
        deviceService.log('info', 'Auto-sync skipped', reason)
        return
      }

      if (autoSyncTriggeredRef.current) return

      autoSyncTriggeredRef.current = true
      if (shouldLogQa()) console.log('[useDeviceSubscriptions] Initial auto-sync check (device pre-connected)')

      await startSafeAutoSync(deviceService, setDeviceSyncStateRef.current)
    }
    checkInitialAutoSync()

    // Reset auto-sync flag on disconnect so it re-triggers on reconnect
    const unsubDeviceDisconnect = deviceService.onStateChange((deviceState) => {
      if (!deviceState.connected) {
        autoSyncTriggeredRef.current = false
      }
    })

    return () => {
      unsubDeviceDisconnect()
    }
  // SM-M02: Dependencies are stable (deviceService is singleton), refs handle action freshness
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceService])
}
