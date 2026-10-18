/**
 * @vitest-environment node
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'C:/tmp/hidock-test') },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn()
  }
}))
import type { Recording } from '../database'
import {
  buildOtterCanonicalMergePlan,
  type OtterCanonicalMergeInventory
} from '../otter-canonical-merge'
import type { OtterReconciliationPreview } from '../otter-reconciliation'

function recording(overrides: Partial<Recording> & Pick<Recording, 'id' | 'filename'>): Recording {
  return {
    id: overrides.id,
    filename: overrides.filename,
    original_filename: overrides.original_filename,
    file_path: overrides.file_path ?? `C:/recordings/${overrides.filename}`,
    file_size: 100,
    duration_seconds: 60,
    date_recorded: overrides.date_recorded ?? '2026-01-01',
    source_date_precision: overrides.source_date_precision ?? 'date-only',
    source_date_evidence: overrides.source_date_evidence,
    status: overrides.status ?? 'complete',
    created_at: '2026-10-18T00:00:00.000Z',
    location: overrides.location ?? 'local-only',
    transcription_status: overrides.transcription_status ?? 'complete',
    on_device: overrides.on_device ?? 0,
    on_local: overrides.on_local ?? 1,
    source: overrides.source ?? 'import',
    is_imported: overrides.is_imported ?? 1
  }
}

function preview(): OtterReconciliationPreview {
  return {
    generatedAt: '2026-10-18T12:00:00.000Z',
    deviceInventoryStart: '2025-11-24T16:29:33.000Z',
    deviceInventoryEnd: '2026-10-16T17:02:15.000Z',
    counts: {
      deviceRecordings: 2,
      importedOtter: 3,
      importedMissingTranscript: 0,
      importedMissingTranscriptUsableAudio: 0,
      importedMissingTranscriptUnusableAudio: 0,
      preDeviceOtterOnly: 1,
      overlappingOtter: 2,
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
    matches: [
      {
        importedRecordingId: 'import-in-place',
        importedFilename: 'Otter one.mp3',
        deviceFilename: '2026Jan01-090000-Rec01.hda',
        deviceRecordedAt: '2026-01-01T15:00:00.000Z',
        method: 'exact-timestamp',
        confidence: 1,
        reviewDecision: 'pending'
      },
      {
        importedRecordingId: 'import-consolidate',
        importedFilename: 'Otter two.mp3',
        deviceFilename: '2026Jan02-090000-Rec02.hda',
        deviceRecordedAt: '2026-01-02T15:00:00.000Z',
        method: 'date-duration',
        confidence: 0.99,
        reviewDecision: 'pending'
      }
    ],
    unresolved: [{
      importedRecordingId: 'import-separate',
      importedFilename: 'Otter only.mp3',
      recordedDate: '2026-01-03',
      durationSeconds: 30,
      nearestCandidates: [],
      reviewDecision: 'pending'
    }]
  }
}

function inventory(extra: Partial<OtterCanonicalMergeInventory> = {}): OtterCanonicalMergeInventory {
  return {
    transcriptRecordingIds: new Set(['import-in-place', 'import-consolidate', 'import-separate']),
    captureRecordingIds: new Set(),
    qualityRecordingIds: new Set(),
    ...extra
  }
}

const recordings = [
  recording({ id: 'import-in-place', filename: 'Otter one.mp3' }),
  recording({ id: 'import-consolidate', filename: 'Otter two.mp3' }),
  recording({ id: 'import-separate', filename: 'Otter only.mp3' }),
  recording({
    id: 'existing-hidock',
    filename: '2026Jan02-090000-Rec02.wav',
    source: 'hidock',
    is_imported: 0,
    transcription_status: 'error',
    on_device: 1,
    location: 'both'
  })
]

describe('Otter canonical merge plan', () => {
  it('accepts proposed matches, detects an existing HiDock base filename, and keeps unresolved items separate', () => {
    const plan = buildOtterCanonicalMergePlan(preview(), recordings, inventory())

    expect(plan.ready).toBe(true)
    expect(plan.counts).toEqual({
      proposedAccepted: 2,
      canonicalizeImported: 1,
      consolidateExisting: 1,
      unresolvedKeptSeparate: 1,
      preDevicePreserved: 1,
      blockers: 0
    })
    expect(plan.actions[1]).toMatchObject({
      kind: 'consolidate-existing',
      canonicalRecordingId: 'existing-hidock'
    })
    expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('blocks consolidation when the existing HiDock row already owns a transcript', () => {
    const plan = buildOtterCanonicalMergePlan(
      preview(),
      recordings,
      inventory({ transcriptRecordingIds: new Set(['import-in-place', 'import-consolidate', 'existing-hidock']) })
    )

    expect(plan.ready).toBe(false)
    expect(plan.counts.blockers).toBe(1)
    expect(plan.blockers[0]).toContain('already has a transcript')
  })

  it('blocks consolidation into another imported row that merely shares the device basename', () => {
    const unsafeRecordings = recordings.map((item) => item.id === 'existing-hidock'
      ? { ...item, source: 'import' as const, is_imported: 1 }
      : item)
    const plan = buildOtterCanonicalMergePlan(preview(), unsafeRecordings, inventory())

    expect(plan.ready).toBe(false)
    expect(plan.blockers).toContain(
      'Otter two.mp3: Existing basename owner is not a canonical HiDock recording.'
    )
  })

  it('changes the fingerprint when a proposed mapping changes', () => {
    const first = buildOtterCanonicalMergePlan(preview(), recordings, inventory())
    const changedPreview = preview()
    changedPreview.matches[0].deviceFilename = '2026Jan01-090500-Rec03.hda'
    const second = buildOtterCanonicalMergePlan(changedPreview, recordings, inventory())

    expect(second.fingerprint).not.toBe(first.fingerprint)
  })

  it('honors saved keep-separate decisions and blocks a redundant rerun', () => {
    const reviewedPreview = preview()
    reviewedPreview.matches.forEach((match) => { match.reviewDecision = 'separate' })
    reviewedPreview.unresolved.forEach((item) => { item.reviewDecision = 'separate' })

    const plan = buildOtterCanonicalMergePlan(reviewedPreview, recordings, inventory())

    expect(plan.ready).toBe(false)
    expect(plan.actions).toEqual([])
    expect(plan.unresolvedRecordingIds).toEqual([])
    expect(plan.counts).toEqual({
      proposedAccepted: 0,
      canonicalizeImported: 0,
      consolidateExisting: 0,
      unresolvedKeptSeparate: 0,
      preDevicePreserved: 1,
      blockers: 1
    })
    expect(plan.blockers).toEqual([
      'No new canonical merge work remains; saved keep-separate decisions are already honored.'
    ])
  })
})
