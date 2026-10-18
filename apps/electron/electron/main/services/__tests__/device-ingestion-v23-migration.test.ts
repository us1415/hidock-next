/**
 * @vitest-environment node
 */

import initSqlJs from 'sql.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, unlinkSync, writeFileSync } from 'fs'

const testState = vi.hoisted(() => ({
  databasePath: `${process.env.TEMP || process.env.TMP || '.'}\\hidock-v23-migration-${process.pid}-${Date.now()}.db`
}))

vi.mock('../file-storage', () => ({
  getDatabasePath: () => testState.databasePath
}))

describe('schema v23 source-date migration', () => {
  beforeAll(async () => {
    const SQL = await initSqlJs()
    const legacy = new SQL.Database()
    legacy.run('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)')
    legacy.run('INSERT INTO schema_version (version) VALUES (22)')
    legacy.run(`
      CREATE TABLE device_ingestion_state (
        device_id TEXT PRIMARY KEY,
        last_seen_recorded_at TEXT,
        last_seen_filename TEXT,
        last_scan_at TEXT NOT NULL,
        last_successful_sync_at TEXT,
        last_successful_sync_recorded_at TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `)
    legacy.run(`
      CREATE TABLE device_review_queue (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        file_size INTEGER,
        recorded_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new',
        first_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
        reviewed_at TEXT,
        UNIQUE(device_id, filename)
      )
    `)
    legacy.run(
      'INSERT INTO device_ingestion_state (device_id, last_scan_at) VALUES (?, ?)',
      ['hidock:P1-MIGRATION', '2026-10-18T10:00:00.000Z']
    )
    legacy.run(
      `INSERT INTO device_review_queue
        (id, device_id, filename, file_size, recorded_at, status, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        'legacy-review',
        'hidock:P1-MIGRATION',
        '2026Oct16-102913-Rec21.hda',
        123,
        '2026-10-16T15:29:13.000Z',
        'dismissed',
        '2026-10-18T10:00:00.000Z'
      ]
    )
    writeFileSync(testState.databasePath, Buffer.from(legacy.export()))
    legacy.close()

    const database = await import('../database')
    await database.initializeDatabase()
  })

  afterAll(async () => {
    const database = await import('../database')
    database.closeDatabase()
    if (existsSync(testState.databasePath)) unlinkSync(testState.databasePath)
  })

  it('preserves existing review rows and permits a null source date', async () => {
    const database = await import('../database')
    const existing = database.getDeviceReviewItems('hidock:P1-MIGRATION')
    expect(existing).toHaveLength(1)
    expect(existing[0]).toMatchObject({
      filename: '2026Oct16-102913-Rec21.hda',
      recorded_at: '2026-10-16T15:29:13.000Z',
      status: 'dismissed'
    })

    database.observeDeviceInventory('hidock:P1-MIGRATION', [
      { filename: 'undated-new-recording.hda', fileSize: 456, recordedAt: null }
    ], '2026-10-18T11:00:00.000Z')

    const undated = database.getDeviceReviewItems('hidock:P1-MIGRATION', 'new')
    expect(undated).toHaveLength(1)
    expect(undated[0].recorded_at).toBeNull()
  })
})
