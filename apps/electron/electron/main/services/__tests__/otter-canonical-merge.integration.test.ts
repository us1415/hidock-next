/**
 * @vitest-environment node
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => {
  const root = `${process.env.TEMP || process.env.TMP || '.'}\\hidock-canonical-merge-${process.pid}-${Date.now()}`
  return { root, databasePath: `${root}\\library.db` }
})

vi.mock('../file-storage', () => ({
  getDatabasePath: () => testState.databasePath
}))

import {
  applyOtterCanonicalMerge,
  buildOtterCanonicalMergePlan,
  type OtterCanonicalMergeInventory
} from '../otter-canonical-merge'
import type { OtterReconciliationPreview } from '../otter-reconciliation'
import * as database from '../database'

describe('Otter canonical merge transaction', () => {
  const archiveRoot = `${testState.root}\\archive`
  const importedAudio = `${testState.root}\\otter-consolidate.mp3`

  beforeAll(async () => {
    mkdirSync(testState.root, { recursive: true })
    await database.initializeDatabase()

    database.insertRecording({
      id: 'import-in-place',
      filename: 'Otter one.mp3',
      original_filename: 'Otter one.mp3',
      file_path: `${testState.root}\\otter-one.mp3`,
      file_size: 100,
      duration_seconds: 60,
      date_recorded: '2026-01-01',
      source_date_precision: 'date-only',
      source_date_evidence: 'otter-export',
      status: 'complete',
      location: 'local-only',
      transcription_status: 'complete',
      on_device: 0,
      on_local: 1,
      source: 'import',
      is_imported: 1
    })
    database.insertRecording({
      id: 'import-consolidate',
      filename: 'Otter two.mp3',
      original_filename: 'Otter two.mp3',
      file_path: importedAudio,
      file_size: 200,
      duration_seconds: 120,
      date_recorded: '2026-01-02',
      source_date_precision: 'date-only',
      source_date_evidence: 'otter-export',
      status: 'complete',
      location: 'local-only',
      transcription_status: 'complete',
      on_device: 0,
      on_local: 1,
      source: 'import',
      is_imported: 1
    })
    database.insertRecording({
      id: 'existing-hidock',
      filename: '2026Jan02-090000-Rec02.wav',
      original_filename: '2026Jan02-090000-Rec02.hda',
      file_path: `${testState.root}\\2026Jan02-090000-Rec02.wav`,
      file_size: 200,
      duration_seconds: 120,
      date_recorded: '2026-01-02T15:00:00.000Z',
      source_date_precision: 'exact',
      source_date_evidence: 'hidock-device',
      status: 'error',
      location: 'both',
      transcription_status: 'error',
      on_device: 1,
      on_local: 1,
      source: 'hidock',
      is_imported: 0
    })
    database.insertRecording({
      id: 'import-separate',
      filename: 'Otter only.mp3',
      original_filename: 'Otter only.mp3',
      file_path: `${testState.root}\\otter-only.mp3`,
      file_size: 50,
      duration_seconds: 30,
      date_recorded: '2026-01-03',
      source_date_precision: 'date-only',
      source_date_evidence: 'otter-export',
      status: 'complete',
      location: 'local-only',
      transcription_status: 'complete',
      on_device: 0,
      on_local: 1,
      source: 'import',
      is_imported: 1
    })

    database.getDatabase().run(
      'INSERT INTO transcripts (id, recording_id, full_text, title_suggestion) VALUES (?, ?, ?, ?)',
      ['transcript-one', 'import-in-place', 'Transcript one', 'Meeting one']
    )
    database.getDatabase().run(
      'INSERT INTO transcripts (id, recording_id, full_text, title_suggestion) VALUES (?, ?, ?, ?)',
      ['transcript-two', 'import-consolidate', 'Transcript two', 'Meeting two']
    )
    writeFileSync(importedAudio, Buffer.from('disposable imported audio'))
  })

  afterAll(() => {
    database.closeDatabase()
    if (existsSync(testState.root)) rmSync(testState.root, { recursive: true, force: true })
  })

  it('canonicalizes, consolidates, archives redundant audio, and records a reversible audit', () => {
    const preview: OtterReconciliationPreview = {
      generatedAt: '2026-10-18T12:00:00.000Z',
      deviceInventoryStart: '2025-11-24T16:29:33.000Z',
      deviceInventoryEnd: '2026-10-16T17:02:15.000Z',
      counts: {
        deviceRecordings: 2,
        importedOtter: 3,
        importedMissingTranscript: 0,
        importedMissingTranscriptUsableAudio: 0,
        importedMissingTranscriptUnusableAudio: 0,
        preDeviceOtterOnly: 0,
        overlappingOtter: 3,
        exactTimestampMatches: 1,
        dateDurationMatches: 1,
        adjacentDateDurationMatches: 0,
        provisionalMatches: 2,
        unresolvedOverlapping: 1,
        deviceWithoutOtterMatch: 0,
        reviewedConfirmed: 0,
        reviewedSeparate: 0,
        reviewPending: 3
      },
      matches: [{
        importedRecordingId: 'import-in-place',
        importedFilename: 'Otter one.mp3',
        deviceFilename: '2026Jan01-090000-Rec01.hda',
        deviceRecordedAt: '2026-01-01T15:00:00.000Z',
        method: 'exact-timestamp',
        confidence: 1,
        reviewDecision: 'pending'
      }, {
        importedRecordingId: 'import-consolidate',
        importedFilename: 'Otter two.mp3',
        deviceFilename: '2026Jan02-090000-Rec02.hda',
        deviceRecordedAt: '2026-01-02T15:00:00.000Z',
        method: 'date-duration',
        confidence: 0.99,
        reviewDecision: 'pending'
      }],
      unresolved: [{
        importedRecordingId: 'import-separate',
        importedFilename: 'Otter only.mp3',
        recordedDate: '2026-01-03',
        durationSeconds: 30,
        nearestCandidates: [],
        reviewDecision: 'pending'
      }]
    }
    const recordings = database.queryAll<database.Recording>('SELECT * FROM recordings')
    const inventory: OtterCanonicalMergeInventory = {
      transcriptRecordingIds: new Set(['import-in-place', 'import-consolidate']),
      captureRecordingIds: new Set(),
      qualityRecordingIds: new Set()
    }
    const plan = buildOtterCanonicalMergePlan(preview, recordings, inventory)

    const result = applyOtterCanonicalMerge(
      plan,
      recordings,
      `${testState.root}\\safety-backup`,
      archiveRoot,
      '2026-10-18T12:05:00.000Z',
      'batch-test'
    )

    expect(result).toMatchObject({ canonicalized: 1, consolidated: 1, keptSeparate: 1 })
    expect(database.getRecordingById('import-in-place')).toMatchObject({
      filename: '2026Jan01-090000-Rec01.hda',
      original_filename: 'Otter one.mp3',
      date_recorded: '2026-01-01T15:00:00.000Z',
      source_date_precision: 'exact',
      source: 'hidock',
      is_imported: 0
    })
    expect(database.getRecordingById('import-consolidate')).toBeUndefined()
    expect(database.getRecordingById('existing-hidock')).toMatchObject({
      date_recorded: '2026-01-02T15:00:00.000Z',
      transcription_status: 'complete',
      status: 'complete'
    })
    expect(database.getTranscriptByRecordingId('existing-hidock')).toMatchObject({
      full_text: 'Transcript two',
      title_suggestion: 'Meeting two'
    })
    expect(database.getRecordingById('import-separate')).toMatchObject({ source: 'import', is_imported: 1 })
    expect(database.queryOne<{ decision: string }>(
      'SELECT decision FROM otter_reconciliation_reviews WHERE imported_recording_id = ?',
      ['import-separate']
    )?.decision).toBe('separate')
    expect(database.queryAll<{ action: string }>(
      'SELECT action FROM otter_reconciliation_merge_audit WHERE batch_id = ? ORDER BY action',
      ['batch-test']
    ).map((row) => row.action)).toEqual(['canonicalized', 'canonicalized', 'kept-separate'])
    expect(database.queryOne<{ backup_path: string }>(
      'SELECT backup_path FROM otter_reconciliation_merge_batches WHERE id = ?',
      ['batch-test']
    )?.backup_path).toBe(`${testState.root}\\safety-backup`)
    expect(existsSync(importedAudio)).toBe(false)
    expect(result.archivedAudioPaths).toHaveLength(1)
    expect(existsSync(result.archivedAudioPaths[0])).toBe(true)
  })
})
