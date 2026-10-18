/** @vitest-environment node */

import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() },
  Notification: vi.fn()
}))

const persistedRows = [
  {
    id: 'failed-1',
    filename: 'failed-recording.hda',
    file_size: 1200,
    progress: 38,
    status: 'failed',
    error: 'USB transfer interrupted',
    started_at: '2026-10-18T10:00:00.000Z',
    completed_at: '2026-10-18T10:01:00.000Z',
    recording_date: '2026-10-16T15:29:13.000Z'
  },
  {
    id: 'cancelled-1',
    filename: 'cancelled-recording.hda',
    file_size: 2400,
    progress: 12,
    status: 'cancelled',
    error: 'Cancelled by user',
    started_at: null,
    completed_at: null,
    recording_date: '2026-10-17T09:00:00.000Z'
  }
]

vi.mock('../database', () => ({
  markRecordingDownloaded: vi.fn(),
  addSyncedFile: vi.fn(),
  isFileSynced: vi.fn(() => false),
  getRecordingByFilename: vi.fn(() => null),
  getSyncedFilenames: vi.fn(() => new Set()),
  queryOne: vi.fn(() => null),
  queryAll: vi.fn(() => persistedRows),
  run: vi.fn(),
  runInTransaction: vi.fn((fn: () => void) => fn())
}))

vi.mock('../file-storage', () => ({
  saveRecording: vi.fn(),
  getRecordingsPath: vi.fn(() => 'C:\\recordings')
}))

vi.mock('../activity-log', () => ({ emitActivityLog: vi.fn() }))

vi.mock('fs', () => ({ existsSync: vi.fn(() => false) }))

import { getDownloadService } from '../download-service'

describe('DownloadService restart hydration', () => {
  const service = getDownloadService()

  afterAll(() => service.destroy())

  it('restores failed and cancelled downloads so retry controls survive restart', () => {
    expect(service.getState().queue).toEqual([
      expect.objectContaining({
        id: 'failed-1',
        filename: 'failed-recording.hda',
        status: 'failed',
        error: 'USB transfer interrupted',
        progress: 38
      }),
      expect.objectContaining({
        id: 'cancelled-1',
        filename: 'cancelled-recording.hda',
        status: 'cancelled',
        error: 'Cancelled by user',
        progress: 12
      })
    ])
  })
})
