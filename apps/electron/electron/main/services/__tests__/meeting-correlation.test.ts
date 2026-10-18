/** @vitest-environment node */

import { describe, expect, it } from 'vitest'
import {
  MIN_AUTOMATIC_MEETING_CONFIDENCE,
  buildRecordingMeetingWindow,
  chooseAutomaticMeetingLink
} from '../meeting-correlation'

describe('meeting correlation policy', () => {
  it('builds the candidate window from the original recording timestamp', () => {
    const window = buildRecordingMeetingWindow('2026-10-16T15:29:13.000Z', 60 * 60)

    expect(window).toEqual({
      startIso: '2026-10-16T14:59:13.000Z',
      endIso: '2026-10-16T16:59:13.000Z'
    })
  })

  it('rejects an invalid recording timestamp instead of falling back to upload time', () => {
    expect(buildRecordingMeetingWindow('not-a-device-date', 1800)).toBeNull()
  })

  it('rejects date-only evidence instead of manufacturing a midnight meeting window', () => {
    expect(buildRecordingMeetingWindow('2026-02-12', 1800, 30, 'date-only')).toBeNull()
    expect(buildRecordingMeetingWindow('2026-02-12', 1800)).toBeNull()
  })

  it('allows a valid high-confidence candidate to link automatically', () => {
    expect(chooseAutomaticMeetingLink({
      existingMeetingId: null,
      existingCorrelationMethod: null,
      selectedMeetingId: 'meeting-1',
      confidence: MIN_AUTOMATIC_MEETING_CONFIDENCE,
      candidateMeetingIds: ['meeting-1', 'meeting-2']
    })).toBe('meeting-1')
  })

  it('keeps a low-confidence choice as a suggestion', () => {
    expect(chooseAutomaticMeetingLink({
      existingMeetingId: null,
      existingCorrelationMethod: null,
      selectedMeetingId: 'meeting-1',
      confidence: MIN_AUTOMATIC_MEETING_CONFIDENCE - 0.01,
      candidateMeetingIds: ['meeting-1']
    })).toBeNull()
  })

  it('rejects a meeting ID that was not in the timestamp-derived candidates', () => {
    expect(chooseAutomaticMeetingLink({
      existingMeetingId: null,
      existingCorrelationMethod: null,
      selectedMeetingId: 'invented-meeting',
      confidence: 1,
      candidateMeetingIds: ['meeting-1']
    })).toBeNull()
  })

  it.each(['manual', 'user_override', 'user_standalone'])(
    'never overrides the user decision represented by %s',
    (existingCorrelationMethod) => {
      expect(chooseAutomaticMeetingLink({
        existingMeetingId: existingCorrelationMethod === 'user_standalone' ? null : 'meeting-1',
        existingCorrelationMethod,
        selectedMeetingId: 'meeting-2',
        confidence: 1,
        candidateMeetingIds: ['meeting-2']
      })).toBeNull()
    }
  )

  it('does not replace a different existing automatic link without review', () => {
    expect(chooseAutomaticMeetingLink({
      existingMeetingId: 'meeting-1',
      existingCorrelationMethod: 'ai_transcript_match',
      selectedMeetingId: 'meeting-2',
      confidence: 1,
      candidateMeetingIds: ['meeting-2']
    })).toBeNull()
  })
})
