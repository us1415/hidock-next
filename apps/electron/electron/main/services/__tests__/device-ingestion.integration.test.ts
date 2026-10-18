import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, unlinkSync } from 'fs'

const testState = vi.hoisted(() => ({
  databasePath: `${process.env.TEMP || process.env.TMP || '.'}\\hidock-device-ingestion-${process.pid}-${Date.now()}.db`
}))

vi.mock('../file-storage', () => ({
  getDatabasePath: () => testState.databasePath
}))

describe('device ingestion baseline and review queue', () => {
  beforeAll(async () => {
    const database = await import('../database')
    await database.initializeDatabase()
  })

  afterAll(async () => {
    const database = await import('../database')
    database.closeDatabase()
    if (existsSync(testState.databasePath)) unlinkSync(testState.databasePath)
  })

  it('baselines existing files, then queues only filenames first seen later', async () => {
    const database = await import('../database')
    const deviceId = 'hidock:P1-TEST-001'

    const baseline = database.observeDeviceInventory(deviceId, [
      { filename: '2026Oct16-102913-Rec21.hda', fileSize: 100, recordedAt: '2026-10-16T15:29:13.000Z' },
      { filename: '2026Oct16-110327-Rec22.hda', fileSize: 200, recordedAt: '2026-10-16T16:03:27.000Z' }
    ], '2026-10-18T15:00:00.000Z')

    expect(baseline.baselineInitialized).toBe(true)
    expect(baseline.newItems).toEqual([])
    expect(baseline.pendingItems).toEqual([])

    const secondScan = database.observeDeviceInventory(deviceId, [
      { filename: '2026Oct16-102913-Rec21.hda', fileSize: 100, recordedAt: '2026-10-16T15:29:13.000Z' },
      { filename: '2026Oct16-110327-Rec22.hda', fileSize: 200, recordedAt: '2026-10-16T16:03:27.000Z' },
      // An older timestamp still counts because discovery is filename-based, not clock-based.
      { filename: '2026Oct15-090000-TransferredLater.hda', fileSize: 300, recordedAt: '2026-10-15T14:00:00.000Z' }
    ], '2026-10-18T16:00:00.000Z')

    expect(secondScan.baselineInitialized).toBe(false)
    expect(secondScan.newItems.map((item) => item.filename)).toEqual([
      '2026Oct15-090000-TransferredLater.hda'
    ])
    expect(secondScan.pendingItems).toHaveLength(1)
  })

  it('records explicit review approval and the last successful sync boundary', async () => {
    const database = await import('../database')
    const deviceId = 'hidock:P1-TEST-001'
    const filename = '2026Oct15-090000-TransferredLater.hda'

    const approved = database.updateDeviceReviewStatus(
      deviceId,
      filename,
      'approved',
      '2026-10-18T16:05:00.000Z'
    )
    expect(approved?.status).toBe('approved')
    expect(database.getDeviceReviewItems(deviceId, 'new')).toEqual([])

    const state = database.markDeviceSyncSuccess(
      deviceId,
      '2026-10-15T14:00:00.000Z',
      '2026-10-18T16:10:00.000Z'
    )
    expect(state?.last_successful_sync_at).toBe('2026-10-18T16:10:00.000Z')
    expect(state?.last_successful_sync_recorded_at).toBe('2026-10-15T14:00:00.000Z')
  })

  it('persists an unknown source date as null instead of observation time', async () => {
    const database = await import('../database')
    const deviceId = 'hidock:P1-UNKNOWN-DATE'

    database.observeDeviceInventory(deviceId, [
      { filename: 'recording-without-date.hda', fileSize: 400, recordedAt: null }
    ], '2026-10-18T17:00:00.000Z')

    const items = database.getDeviceReviewItems(deviceId)
    expect(items).toHaveLength(1)
    expect(items[0].recorded_at).toBeNull()
    expect(items[0].first_seen_at).toBe('2026-10-18T17:00:00.000Z')
    expect(items[0].recorded_at).not.toBe(items[0].first_seen_at)
  })
})
