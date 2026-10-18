import { beforeEach, describe, expect, it, vi } from 'vitest'
import { startSafeAutoSync } from '../useDeviceSubscriptions'

vi.mock('@/services/qa-monitor', () => ({ shouldLogQa: () => false }))

function makeRecording(index: number) {
  return {
    id: `device-${index}`,
    filename: `2026Oct18-1000${String(index).padStart(2, '0')}-Rec${index}.hda`,
    size: 12_000,
    duration: 1,
    dateCreated: new Date(`2026-10-18T10:00:${String(index % 60).padStart(2, '0')}`)
  }
}

function makeDevice(recordings: ReturnType<typeof makeRecording>[]) {
  return {
    getState: vi.fn(() => ({ connected: true, serialNumber: 'P1-safe-test', model: 'hidock-p1' })),
    getCachedRecordings: vi.fn(() => recordings),
    log: vi.fn()
  } as any
}

function installApi(observation: { baselineInitialized: boolean; pendingItems: Array<{ filename: string }> }) {
  const api = {
    deviceIngestion: {
      observeInventory: vi.fn().mockResolvedValue({
        ...observation,
        newItems: [],
        state: {}
      }),
      updateReviewStatus: vi.fn().mockResolvedValue({ status: 'approved' })
    },
    downloadService: {
      getFilesToSync: vi.fn().mockImplementation(async (files) => files),
      startSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' })
    }
  }
  Object.defineProperty(window, 'electronAPI', {
    value: api,
    writable: true,
    configurable: true
  })
  return api
}

describe('startSafeAutoSync', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates a first-scan baseline without downloading the historical archive', async () => {
    const recordings = [makeRecording(1), makeRecording(2)]
    const device = makeDevice(recordings)
    const api = installApi({ baselineInitialized: true, pendingItems: [] })
    const setDeviceSyncState = vi.fn()

    const result = await startSafeAutoSync(device, setDeviceSyncState)

    expect(result).toEqual({ queued: 0, baselineInitialized: true, reason: 'no-new-review-items' })
    expect(api.downloadService.getFilesToSync).not.toHaveBeenCalled()
    expect(api.downloadService.startSession).not.toHaveBeenCalled()
    expect(setDeviceSyncState).not.toHaveBeenCalled()
  })

  it('downloads only filenames still awaiting review and marks them approved', async () => {
    const historical = makeRecording(1)
    const newlyDetected = makeRecording(2)
    const device = makeDevice([historical, newlyDetected])
    const api = installApi({
      baselineInitialized: false,
      pendingItems: [{ filename: newlyDetected.filename }]
    })
    const setDeviceSyncState = vi.fn()

    const result = await startSafeAutoSync(device, setDeviceSyncState)

    expect(result).toEqual({ queued: 1, baselineInitialized: false })
    expect(api.downloadService.getFilesToSync).toHaveBeenCalledWith([
      expect.objectContaining({ filename: newlyDetected.filename })
    ])
    expect(api.downloadService.startSession).toHaveBeenCalledWith([
      expect.objectContaining({ filename: newlyDetected.filename })
    ])
    expect(api.deviceIngestion.updateReviewStatus).toHaveBeenCalledWith({
      deviceId: 'hidock:P1-safe-test',
      filename: newlyDetected.filename,
      status: 'approved'
    })
    expect(setDeviceSyncState).toHaveBeenCalledWith({
      deviceSyncing: true,
      deviceSyncProgress: { total: 1, current: 0 },
      deviceFileDownloading: newlyDetected.filename
    })
  })

  it('pauses instead of automatically downloading more than the safety cap', async () => {
    const recordings = Array.from({ length: 21 }, (_, index) => makeRecording(index))
    const device = makeDevice(recordings)
    const api = installApi({
      baselineInitialized: false,
      pendingItems: recordings.map((recording) => ({ filename: recording.filename }))
    })

    const result = await startSafeAutoSync(device, vi.fn())

    expect(result.reason).toBe('automatic-limit-exceeded')
    expect(api.downloadService.startSession).not.toHaveBeenCalled()
    expect(device.log).toHaveBeenCalledWith(
      'warning',
      'Auto-sync paused',
      expect.stringContaining('manual selection')
    )
  })

  it('keeps an undated recording in review and never auto-downloads it', async () => {
    const undated = { ...makeRecording(1), filename: 'undated-recording.hda', dateCreated: null }
    const device = makeDevice([undated as any])
    const api = installApi({
      baselineInitialized: false,
      pendingItems: [{ filename: undated.filename }]
    })

    const result = await startSafeAutoSync(device, vi.fn())

    expect(result).toEqual({ queued: 0, baselineInitialized: false, reason: 'source-date-unknown' })
    expect(api.deviceIngestion.observeInventory).toHaveBeenCalledWith(expect.objectContaining({
      files: [expect.objectContaining({ filename: undated.filename, recordedAt: null })]
    }))
    expect(api.downloadService.getFilesToSync).not.toHaveBeenCalled()
    expect(api.downloadService.startSession).not.toHaveBeenCalled()
  })
})
