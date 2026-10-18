/**
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const databaseMocks = vi.hoisted(() => ({
  queryAll: vi.fn(),
  getRecordingByFilename: vi.fn(() => null),
  getSyncedFile: vi.fn(() => null)
}))

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  readdirSync: vi.fn(() => ['otter-batch-0001-human-title.mp3']),
  statSync: vi.fn(() => ({ size: 45, mtime: new Date('2026-01-01T12:00:00.000Z') })),
  unlinkSync: vi.fn(),
  utimesSync: vi.fn()
}))
vi.mock('../file-storage', () => ({ getRecordingsPath: vi.fn(() => 'C:/HiDock/recordings') }))
vi.mock('../database', () => ({
  getDatabase: vi.fn(),
  queryAll: databaseMocks.queryAll,
  run: vi.fn(),
  saveDatabase: vi.fn(),
  getRecordingByFilename: databaseMocks.getRecordingByFilename,
  getSyncedFile: databaseMocks.getSyncedFile,
  addSyncedFile: vi.fn(),
  removeSyncedFile: vi.fn()
}))

import { getIntegrityService } from '../integrity-service'

describe('integrity physical-file ownership', () => {
  beforeEach(() => {
    databaseMocks.queryAll.mockImplementation((sql: string) => {
      if (sql.includes('FROM synced_files')) return []
      if (sql.includes("source = 'import'")) {
        return [{ file_path: 'C:/HiDock/recordings/otter-batch-0001-human-title.mp3' }]
      }
      if (sql.includes('SELECT file_path FROM recordings')) {
        return [{ file_path: 'C:/HiDock/recordings/otter-batch-0001-human-title.mp3' }]
      }
      if (sql.includes('FROM recordings')) {
        return [{
          id: 'imported-recording',
          filename: 'Human title.mp3',
          file_path: 'C:/HiDock/recordings/otter-batch-0001-human-title.mp3',
          file_size: 45,
          date_recorded: '2026-01-01',
          source: 'import',
          is_imported: 1
        }]
      }
      return []
    })
  })

  it('does not call a tracked collision-safe import orphaned or an incomplete download', async () => {
    const report = await getIntegrityService().runFullScan()

    expect(report.totalIssues).toBe(0)
    expect(databaseMocks.getRecordingByFilename).not.toHaveBeenCalled()
  })
})
