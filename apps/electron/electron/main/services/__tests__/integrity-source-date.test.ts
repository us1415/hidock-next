/**
 * @vitest-environment node
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('../database', () => ({}))
vi.mock('../file-storage', () => ({ getRecordingsPath: vi.fn() }))

import { getRecordingSourceDateIssue, parseHiDockFilenameDate } from '../integrity-service'

describe('integrity source-date policy', () => {
  const now = new Date('2026-10-18T12:00:00.000Z')

  it('never proposes ingestion time as a replacement for an old source date', () => {
    const issue = getRecordingSourceDateIssue({
      id: 'old-recording',
      filename: 'unknown-date.mp3',
      date_recorded: '2000-01-01T00:00:00.000Z'
    }, now)

    expect(issue).toMatchObject({ suggestedAction: 'manual', autoRepairable: false })
    expect(issue?.details).not.toHaveProperty('suggested_date')
  })

  it('never proposes the current time as a replacement for a future source date', () => {
    const issue = getRecordingSourceDateIssue({
      id: 'future-recording',
      filename: 'unknown-date.mp3',
      date_recorded: '2030-01-01T00:00:00.000Z'
    }, now)

    expect(issue).toMatchObject({ suggestedAction: 'manual', autoRepairable: false })
    expect(issue?.details).not.toHaveProperty('suggested_date')
  })

  it('parses only complete HiDock timestamps at the start of a filename', () => {
    expect(parseHiDockFilenameDate('2026Oct16-102913-Rec21.mp3')?.getFullYear()).toBe(2026)
    expect(parseHiDockFilenameDate('HDA_20261016_102913.hda')?.getFullYear()).toBe(2026)
    expect(parseHiDockFilenameDate('2026-10-16_1029-meeting.mp3')?.getFullYear()).toBe(2026)
    expect(parseHiDockFilenameDate('2026Feb31-102913-invalid.mp3')).toBeUndefined()
  })

  it('does not reinterpret Otter collision-safe names or numeric titles as device dates', () => {
    expect(parseHiDockFilenameDate('otter-055d7df1-0349-5783813552301322240.mp3')).toBeUndefined()
    expect(parseHiDockFilenameDate('5783813552301322240.mp3')).toBeUndefined()
  })
})
