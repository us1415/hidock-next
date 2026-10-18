/**
 * @vitest-environment node
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'

const databaseMocks = vi.hoisted(() => ({
  importOtterRecordsAtomically: vi.fn()
}))

vi.mock('../database', () => databaseMocks)

import { commitOtterImport, extractOtterSpeakers, parseOtterSourceDate, previewOtterImport } from '../otter-import'

const testRoots: string[] = []

function createArchive(entries: Record<string, string>): string {
  const root = mkdtempSync(join(process.cwd(), '.otter-import-test-'))
  testRoots.push(root)
  const archivePath = join(root, 'otter-export.zip')
  const encoded = Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, strToU8(value)]))
  writeFileSync(archivePath, Buffer.from(zipSync(encoded)))
  return archivePath
}

afterEach(() => {
  databaseMocks.importOtterRecordsAtomically.mockReset()
  for (const root of testRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Otter import preview', () => {
  it('recovers exact local source timestamps from Otter filenames', () => {
    const parsed = parseOtterSourceDate('2026Sep03-103050-team Dev sync', 'September 03, 2026')

    expect(parsed.evidence).toBe('filename-timestamp')
    expect(parsed.recordedDate).toBe('2026-09-03')
    expect(parsed.recordedAt).toBe(new Date(2026, 8, 3, 10, 30, 50).toISOString())
  })

  it('keeps summary-only dates explicitly date-only instead of inventing a time', () => {
    expect(parseOtterSourceDate('Interview with Nextiva', 'Interview with Nextiva\nFebruary 12, 2026\n'))
      .toEqual({ recordedAt: null, recordedDate: '2026-02-12', evidence: 'summary-date' })
  })

  it('extracts stable speaker labels from Otter transcript headers', () => {
    const transcript = 'Joel K  00:04\nHello\n\nJoey A  01:02:03\nHi\n\nJoel K  02:00\nAgain'
    expect(extractOtterSpeakers(transcript)).toEqual(['Joel K', 'Joey A'])
  })

  it('classifies ready, date-review, missing-transcript, and existing duplicate conversations', async () => {
    const duplicateText = `Existing speaker  00:01\n${'same transcript content '.repeat(20)}`
    const archivePath = createArchive({
      '2026Sep03-103050-Team Sync.mp3': 'audio-one',
      '2026Sep03-103050-Team Sync_transcript.txt': `Joel K  00:04\n${'ready transcript '.repeat(20)}`,
      '2026Sep03-103050-Team Sync_summary.txt': 'Team Sync\nSeptember 03, 2026\n\nOverview\nReady.',
      'Interview with Nextiva.mp3': 'audio-two',
      'Interview with Nextiva_transcript.txt': `Alex  00:01\n${'date review transcript '.repeat(20)}`,
      'Interview with Nextiva_summary.txt': 'Interview with Nextiva\nFebruary 12, 2026\n\nOverview\nReview.',
      '2026Oct01-150051-Missing.mp3': 'audio-three',
      '2026Oct01-150051-Missing_summary.txt': 'Missing\nOctober 01, 2026',
      '2026Oct02-090000-Duplicate.mp3': 'audio-four',
      '2026Oct02-090000-Duplicate_transcript.txt': duplicateText,
      '2026Oct02-090000-Duplicate_summary.txt': 'Duplicate\nOctober 02, 2026'
    })

    const preview = await previewOtterImport(archivePath, [{
      recordingId: 'existing-recording',
      filename: 'different.mp3',
      transcriptText: duplicateText
    }], new Date('2026-10-18T17:00:00.000Z'))

    expect(preview.counts).toMatchObject({
      total: 4,
      ready: 1,
      dateReview: 1,
      missingTranscript: 1,
      duplicate: 1,
      audioFiles: 4,
      transcriptFiles: 3,
      summaryFiles: 4,
      uniqueSpeakers: 3
    })
    expect(preview.items.find((item) => item.title === 'Team Sync')?.status).toBe('ready')
    expect(preview.items.find((item) => item.title === 'Team Sync')?.sourceDatePrecision).toBe('exact')
    expect(preview.items.find((item) => item.title === 'Interview with Nextiva')).toMatchObject({
      status: 'date-review',
      recordedDate: '2026-02-12',
      recordedAt: null,
      sourceDatePrecision: 'date-only'
    })
    expect(preview.items.find((item) => item.title === 'Missing')?.status).toBe('missing-transcript')
    expect(preview.items.find((item) => item.title === 'Duplicate')).toMatchObject({
      status: 'duplicate',
      duplicateRecordingId: 'existing-recording',
      duplicateReason: 'transcript'
    })
  })

  it('stages selected audio and submits exact and date-only records as one database batch', async () => {
    const archivePath = createArchive({
      '2026Sep03-103050-Team Sync.mp3': 'exact-audio',
      '2026Sep03-103050-Team Sync_transcript.txt': 'Joel K  00:04\nAn exact transcript with enough useful words.',
      '2026Sep03-103050-Team Sync_summary.txt': 'Team Sync\nSeptember 03, 2026',
      'Interview.mp3': 'date-only-audio',
      'Interview_transcript.txt': 'Alex  00:01\nA date-only transcript with useful words.',
      'Interview_summary.txt': 'Interview\nFebruary 12, 2026'
    })
    const recordingsDirectory = join(dirname(archivePath), 'recordings')

    const result = await commitOtterImport(
      archivePath,
      recordingsDirectory,
      ['2026Sep03-103050-Team Sync', 'Interview']
    )

    expect(result).toMatchObject({ imported: 2, withTranscripts: 2, audioOnly: 0 })
    expect(databaseMocks.importOtterRecordsAtomically).toHaveBeenCalledTimes(1)
    const batch = databaseMocks.importOtterRecordsAtomically.mock.calls[0][0]
    expect(batch[0].recording).toMatchObject({
      date_recorded: new Date(2026, 8, 3, 10, 30, 50).toISOString(),
      source_date_precision: 'exact',
      source_date_evidence: 'otter-filename-timestamp',
      source: 'import',
      is_imported: 1,
      transcription_status: 'complete'
    })
    expect(batch[1].recording).toMatchObject({
      date_recorded: '2026-02-12',
      source_date_precision: 'date-only',
      source_date_evidence: 'otter-summary-date'
    })
    expect(batch[1].transcript).toMatchObject({
      transcription_provider: 'otter-import',
      transcription_model: 'otter-export',
      title_suggestion: 'Interview'
    })
    expect(readdirSync(recordingsDirectory).filter((name) => name.endsWith('.mp3'))).toHaveLength(2)
    expect(statSync(batch[0].recording.file_path).mtime.toISOString()).toBe(batch[0].recording.date_recorded)
  })

  it('removes newly extracted files when the database transaction fails', async () => {
    const archivePath = createArchive({
      '2026Sep03-103050-Team Sync.mp3': 'audio',
      '2026Sep03-103050-Team Sync_transcript.txt': 'Joel K  00:04\nTranscript text.',
      '2026Sep03-103050-Team Sync_summary.txt': 'Team Sync\nSeptember 03, 2026'
    })
    const recordingsDirectory = join(dirname(archivePath), 'recordings')
    databaseMocks.importOtterRecordsAtomically.mockImplementationOnce(() => {
      throw new Error('database failure')
    })

    await expect(commitOtterImport(
      archivePath,
      recordingsDirectory,
      ['2026Sep03-103050-Team Sync']
    )).rejects.toThrow('database failure')

    expect(existsSync(recordingsDirectory)).toBe(true)
    expect(readdirSync(recordingsDirectory)).toEqual([])
  })
})
