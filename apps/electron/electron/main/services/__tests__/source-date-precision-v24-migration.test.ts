/**
 * @vitest-environment node
 */

import initSqlJs from 'sql.js'
import { existsSync, unlinkSync, writeFileSync } from 'fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
  databasePath: `${process.env.TEMP || process.env.TMP || '.'}\\hidock-v24-migration-${process.pid}-${Date.now()}.db`
}))

vi.mock('../file-storage', () => ({
  getDatabasePath: () => testState.databasePath
}))

describe('schema v24 source-date precision migration', () => {
  beforeAll(async () => {
    const SQL = await initSqlJs()
    const legacy = new SQL.Database()
    legacy.run('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)')
    legacy.run('INSERT INTO schema_version (version) VALUES (23)')
    legacy.run(`
      CREATE TABLE recordings (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        original_filename TEXT,
        file_path TEXT,
        file_size INTEGER,
        duration_seconds REAL,
        date_recorded TEXT NOT NULL,
        meeting_id TEXT,
        correlation_confidence REAL,
        correlation_method TEXT,
        status TEXT DEFAULT 'pending',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        location TEXT DEFAULT 'device-only',
        transcription_status TEXT DEFAULT 'none',
        on_device INTEGER DEFAULT 1,
        device_last_seen TEXT,
        on_local INTEGER DEFAULT 0,
        source TEXT DEFAULT 'hidock',
        is_imported INTEGER DEFAULT 0,
        storage_tier TEXT,
        migrated_to_capture_id TEXT,
        migration_status TEXT DEFAULT 'pending',
        migrated_at TEXT
      )
    `)
    legacy.run(
      `INSERT INTO recordings
        (id, filename, date_recorded, created_at, location, on_device, on_local, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'legacy-recording',
        '2026Oct16-102913-Rec21.mp3',
        '2026-10-16T15:29:13.000Z',
        '2026-10-18T20:00:00.000Z',
        'local-only',
        0,
        1,
        'external'
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

  it('preserves source chronology and marks existing rows as exact', async () => {
    const database = await import('../database')
    const migrated = database.getRecordingById('legacy-recording')

    expect(migrated).toMatchObject({
      date_recorded: '2026-10-16T15:29:13.000Z',
      created_at: '2026-10-18T20:00:00.000Z',
      source_date_precision: 'exact'
    })
    expect(migrated?.source_date_evidence).toBeNull()

    const version = database.getDatabase().exec('SELECT MAX(version) FROM schema_version')
    expect(version[0].values[0][0]).toBe(25)
    const reviewTable = database.getDatabase().exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'otter_reconciliation_reviews'"
    )
    expect(reviewTable[0].values[0][0]).toBe('otter_reconciliation_reviews')
  })
})
