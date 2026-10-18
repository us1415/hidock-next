/**
 * Pure policy helpers for recording-to-meeting correlation.
 *
 * The recording's `date_recorded` value is the authoritative source timestamp.
 * Upload/import time must never be used to build the matching window.
 */

export const MIN_AUTOMATIC_MEETING_CONFIDENCE = 0.75

const USER_DECIDED_CORRELATION_METHODS = new Set([
  'manual',
  'user_override',
  'user_standalone'
])

export interface RecordingMeetingWindow {
  startIso: string
  endIso: string
}

export function buildRecordingMeetingWindow(
  dateRecorded: string,
  durationSeconds: number | null | undefined,
  bufferMinutes = 30,
  sourceDatePrecision: 'exact' | 'date-only' | 'unknown' = 'exact'
): RecordingMeetingWindow | null {
  // A calendar candidate requires a real wall-clock time. Date-only evidence
  // must never be interpreted as midnight because that manufactures a time.
  if (sourceDatePrecision !== 'exact' || /^\d{4}-\d{2}-\d{2}$/.test(dateRecorded.trim())) return null
  const recordedAtMs = new Date(dateRecorded).getTime()
  if (!Number.isFinite(recordedAtMs)) return null

  const safeDurationSeconds = typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 0
    ? durationSeconds
    : 30 * 60
  const safeBufferMinutes = Number.isFinite(bufferMinutes) && bufferMinutes >= 0 ? bufferMinutes : 30
  const bufferMs = safeBufferMinutes * 60 * 1000

  return {
    startIso: new Date(recordedAtMs - bufferMs).toISOString(),
    endIso: new Date(recordedAtMs + safeDurationSeconds * 1000 + bufferMs).toISOString()
  }
}

export interface AutomaticMeetingLinkInput {
  existingMeetingId: string | null | undefined
  existingCorrelationMethod: string | null | undefined
  selectedMeetingId: string | null | undefined
  confidence: number | null | undefined
  candidateMeetingIds: Iterable<string>
}

/**
 * Return the meeting that may be linked automatically, or null when the choice
 * must remain a suggestion for user review.
 */
export function chooseAutomaticMeetingLink(input: AutomaticMeetingLinkInput): string | null {
  if (input.existingCorrelationMethod && USER_DECIDED_CORRELATION_METHODS.has(input.existingCorrelationMethod)) {
    return null
  }

  if (!input.selectedMeetingId) return null

  const candidateIds = new Set(input.candidateMeetingIds)
  if (!candidateIds.has(input.selectedMeetingId)) return null

  const confidence = input.confidence ?? 0
  if (!Number.isFinite(confidence) || confidence < MIN_AUTOMATIC_MEETING_CONFIDENCE) return null

  // Do not replace an existing link with a different automatic guess. A user
  // can inspect the candidate and explicitly change the meeting instead.
  if (input.existingMeetingId && input.existingMeetingId !== input.selectedMeetingId) return null

  return input.selectedMeetingId
}
