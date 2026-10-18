/**
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest'
import type { Recording } from '../database'
import { buildOtterReconciliationPreview, type ReconciliationDeviceFile } from '../otter-reconciliation'

function imported(overrides: Partial<Recording> & Pick<Recording, 'id' | 'filename' | 'date_recorded'>): Recording {
  return {
    file_path: `C:/recordings/${overrides.id}.mp3`,
    status: 'ready',
    location: 'local-only',
    transcription_status: 'complete',
    on_device: 0,
    on_local: 1,
    source: 'import',
    is_imported: 1,
    created_at: '2026-10-18T12:00:00.000Z',
    ...overrides
  }
}

describe('Otter-to-HiDock reconciliation preview', () => {
  it('separates pre-device audio and proposes exact-time and date-duration matches without mutating data', async () => {
    const recordings = [
      imported({
        id: 'pre-device',
        filename: 'Old interview.mp3',
        date_recorded: '2025-04-01',
        source_date_precision: 'date-only'
      }),
      imported({
        id: 'exact',
        filename: 'Exact meeting.mp3',
        date_recorded: '2025-11-24T16:29:33.000Z',
        source_date_precision: 'exact'
      }),
      imported({
        id: 'duration',
        filename: 'Duration meeting.mp3',
        date_recorded: '2025-11-25',
        source_date_precision: 'date-only'
      }),
      imported({
        id: 'unresolved',
        filename: 'Unknown meeting.mp3',
        date_recorded: '2025-11-26',
        source_date_precision: 'date-only',
        transcription_status: 'none'
      })
    ]
    const deviceFiles: ReconciliationDeviceFile[] = [
      {
        filename: '2025Nov24-102933-Rec00.hda',
        size: 1_200_000,
        duration: 400,
        dateCreated: '2025-11-24T16:29:33.000Z'
      },
      {
        filename: '2025Nov25-090000-Rec01.hda',
        size: 2_400_000,
        duration: 800,
        dateCreated: '2025-11-25T15:00:00.000Z'
      },
      {
        filename: '2025Nov26-090000-Rec02.hda',
        size: 3_600_000,
        duration: 1200,
        dateCreated: '2025-11-26T15:00:00.000Z'
      }
    ]
    const durations: Record<string, number> = {
      'C:/recordings/duration.mp3': 201,
      'C:/recordings/unresolved.mp3': 50
    }

    const preview = await buildOtterReconciliationPreview(
      recordings,
      deviceFiles,
      async (filePath) => durations[filePath],
      '2026-10-18T18:00:00.000Z'
    )

    expect(preview.counts).toEqual({
      deviceRecordings: 3,
      importedOtter: 4,
      importedMissingTranscript: 1,
      importedMissingTranscriptUsableAudio: 1,
      importedMissingTranscriptUnusableAudio: 0,
      preDeviceOtterOnly: 1,
      overlappingOtter: 3,
      exactTimestampMatches: 1,
      dateDurationMatches: 1,
      adjacentDateDurationMatches: 0,
      provisionalMatches: 2,
      unresolvedOverlapping: 1,
      deviceWithoutOtterMatch: 1
    })
    expect(preview.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ importedRecordingId: 'exact', method: 'exact-timestamp', confidence: 1 }),
      expect.objectContaining({
        importedRecordingId: 'duration',
        deviceFilename: '2025Nov25-090000-Rec01.hda',
        method: 'date-duration',
        durationDifferenceSeconds: 1
      })
    ]))
    expect(preview.unresolved[0]).toMatchObject({
      importedRecordingId: 'unresolved',
      nearestCandidates: [{ deviceFilename: '2025Nov26-090000-Rec02.hda' }]
    })
  })

  it('does not force a duration match outside the five-second tolerance', async () => {
    const preview = await buildOtterReconciliationPreview(
      [imported({
        id: 'outside-tolerance',
        filename: 'Meeting.mp3',
        date_recorded: '2026-01-05',
        source_date_precision: 'date-only'
      })],
      [{
        filename: '2026Jan05-090000-Rec01.hda',
        size: 1_200_000,
        duration: 400,
        dateCreated: '2026-01-05T15:00:00.000Z'
      }],
      async () => 106
    )

    expect(preview.counts.provisionalMatches).toBe(0)
    expect(preview.counts.unresolvedOverlapping).toBe(1)
  })

  it('falls back to same-day duration when an exact Otter timestamp does not match the device clock', async () => {
    const preview = await buildOtterReconciliationPreview(
      [imported({
        id: 'clock-drift',
        filename: 'Clock drift meeting.mp3',
        date_recorded: '2026-01-05T16:00:00.000Z',
        source_date_precision: 'exact'
      })],
      [{
        filename: '2026Jan05-110000-Rec01.hda',
        size: 1_200_000,
        duration: 400,
        dateCreated: '2026-01-05T17:00:00.000Z'
      }],
      async () => 100.5
    )

    expect(preview.counts.exactTimestampMatches).toBe(0)
    expect(preview.counts.dateDurationMatches).toBe(1)
    expect(preview.matches[0]).toMatchObject({
      importedRecordingId: 'clock-drift',
      method: 'date-duration',
      durationDifferenceSeconds: 0.5
    })
  })

  it('proposes adjacent-day duration evidence only for a date-only Otter record', async () => {
    const preview = await buildOtterReconciliationPreview(
      [imported({
        id: 'date-boundary',
        filename: 'April 2 meeting.mp3',
        date_recorded: '2026-04-03',
        source_date_precision: 'date-only'
      })],
      [{
        filename: '2026Apr02-090000-Rec01.hda',
        size: 1_200_000,
        duration: 400,
        dateCreated: '2026-04-02T14:00:00.000Z'
      }],
      async () => 100.5
    )

    expect(preview.counts.adjacentDateDurationMatches).toBe(1)
    expect(preview.counts.unresolvedOverlapping).toBe(0)
    expect(preview.matches[0]).toMatchObject({
      importedRecordingId: 'date-boundary',
      method: 'adjacent-date-duration',
      durationDifferenceSeconds: 0.5
    })
  })
})
