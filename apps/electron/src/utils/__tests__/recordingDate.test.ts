import { describe, expect, it } from 'vitest'
import {
  parseRecordingDateFromFilename,
  resolveSourceRecordingDate,
  sourceRecordingDateIso
} from '../recordingDate'

describe('recording source-date resolution', () => {
  it('uses a HiDock filename timestamp as authoritative source chronology', () => {
    const result = parseRecordingDateFromFilename('2026Oct16-102913-Rec21.hda')

    expect(result).not.toBeNull()
    expect(result?.getFullYear()).toBe(2026)
    expect(result?.getMonth()).toBe(9)
    expect(result?.getDate()).toBe(16)
    expect(result?.getHours()).toBe(10)
    expect(result?.getMinutes()).toBe(29)
    expect(result?.getSeconds()).toBe(13)
  })

  it('uses valid device metadata when the filename has no timestamp', () => {
    expect(sourceRecordingDateIso('meeting.hda', '2026-10-16T15:29:13.000Z'))
      .toBe('2026-10-16T15:29:13.000Z')
  })

  it('keeps the source date unknown instead of substituting the current time', () => {
    expect(resolveSourceRecordingDate('meeting-without-date.hda', null)).toBeNull()
    expect(sourceRecordingDateIso('meeting-without-date.hda', 'not-a-date')).toBeNull()
  })
})
