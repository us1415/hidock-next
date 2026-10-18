import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { queryAll } from './database'
import { normalizeSpeakerLabel } from './speaker-identities'

const execFileAsync = promisify(execFile)
const SPEAKER_HEADER = /^(.+?)\s{2,}((?:\d{1,2}:)?\d{2}:\d{2})$/

export interface SpeakerReferenceCandidate {
  startSeconds: number
  endSeconds: number
  durationSeconds: number
}

export interface KnownSpeakerReference {
  identityId: string
  name: string
  dataUrl: string
}

interface ReferenceSourceRow {
  identity_id: string
  display_name: string
  raw_label: string
  file_path: string
  full_text: string
}

interface CandidateMeeting {
  organizer_name?: string | null
  attendees?: string | null
}

function timestampSeconds(value: string): number | null {
  const parts = value.split(':').map(Number)
  if (parts.some((part) => !Number.isFinite(part))) return null
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return null
}

export function extractSpeakerReferenceCandidates(fullText: string, rawLabel: string): SpeakerReferenceCandidate[] {
  const turns: Array<{ label: string; start: number }> = []
  for (const line of fullText.split(/\r?\n/)) {
    const match = line.trim().match(SPEAKER_HEADER)
    if (!match) continue
    const start = timestampSeconds(match[2])
    if (start !== null) turns.push({ label: match[1].trim(), start })
  }

  const candidates: SpeakerReferenceCandidate[] = []
  for (let index = 0; index < turns.length - 1; index += 1) {
    const turn = turns[index]
    if (turn.label !== rawLabel) continue
    const available = turns[index + 1].start - turn.start
    if (available < 2.5) continue
    const startSeconds = turn.start + 0.25
    const durationSeconds = Math.min(8, available - 0.5)
    if (durationSeconds < 2) continue
    candidates.push({
      startSeconds,
      endSeconds: startSeconds + durationSeconds,
      durationSeconds
    })
  }
  return candidates.sort((left, right) => right.durationSeconds - left.durationSeconds)
}

function meetingNames(meetings: CandidateMeeting[]): string[] {
  const names: string[] = []
  for (const meeting of meetings) {
    if (meeting.organizer_name?.trim()) names.push(meeting.organizer_name.trim())
    if (!meeting.attendees) continue
    try {
      const attendees = JSON.parse(meeting.attendees) as Array<{ name?: string }>
      for (const attendee of attendees) if (attendee.name?.trim()) names.push(attendee.name.trim())
    } catch {
      // Calendar attendee metadata is optional and may be malformed.
    }
  }
  return names
}

export function selectKnownSpeakerIdentityIds(meetings: CandidateMeeting[], limit = 4): string[] {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 4, 4))
  const self = queryAll<{ id: string }>(
    "SELECT id FROM speaker_identities WHERE is_self = 1 AND status = 'confirmed' LIMIT 1"
  )
  const selected = self.map((row) => row.id)
  const keys = [...new Set(meetingNames(meetings).map((name) => normalizeSpeakerLabel(name).canonicalKey).filter(Boolean))]
  if (keys.length > 0 && selected.length < safeLimit) {
    const placeholders = keys.map(() => '?').join(',')
    const matches = queryAll<{ id: string }>(`
      WITH latest AS (SELECT MAX(recorded_at) AS recorded_at FROM speaker_occurrences)
      SELECT i.id
      FROM speaker_identities i
      LEFT JOIN contacts c ON c.id = i.contact_id
      LEFT JOIN speaker_aliases a ON a.identity_id = i.id
      LEFT JOIN speaker_occurrences o ON o.alias_id = a.id
      CROSS JOIN latest
      WHERE i.status = 'confirmed' AND i.canonical_key IN (${placeholders})
      GROUP BY i.id
      ORDER BY
        CASE WHEN i.is_priority = 1 OR c.type = 'team' THEN 1 ELSE 0 END DESC,
        SUM(CASE WHEN julianday(o.recorded_at) >= julianday(latest.recorded_at, '-90 days') THEN 1 ELSE 0 END) DESC,
        COUNT(o.id) DESC,
        MAX(o.recorded_at) DESC,
        i.display_name COLLATE NOCASE
    `, keys)
    for (const match of matches) if (!selected.includes(match.id)) selected.push(match.id)
  }

  if (selected.length < safeLimit) {
    const ranked = queryAll<{ id: string }>(`
      WITH latest AS (SELECT MAX(recorded_at) AS recorded_at FROM speaker_occurrences)
      SELECT i.id
      FROM speaker_identities i
      LEFT JOIN contacts c ON c.id = i.contact_id
      LEFT JOIN speaker_aliases a ON a.identity_id = i.id
      LEFT JOIN speaker_occurrences o ON o.alias_id = a.id
      CROSS JOIN latest
      WHERE i.status = 'confirmed' AND i.is_self = 0
      GROUP BY i.id
      ORDER BY
        CASE WHEN i.is_priority = 1 OR c.type = 'team' THEN 1 ELSE 0 END DESC,
        SUM(CASE WHEN julianday(o.recorded_at) >= julianday(latest.recorded_at, '-90 days') THEN 1 ELSE 0 END) DESC,
        COUNT(o.id) DESC,
        MAX(o.recorded_at) DESC,
        i.display_name COLLATE NOCASE
    `)
    for (const candidate of ranked) {
      if (!selected.includes(candidate.id)) selected.push(candidate.id)
      if (selected.length >= safeLimit) break
    }
  }
  return selected.slice(0, safeLimit)
}

function referenceSources(identityIds: string[]): ReferenceSourceRow[] {
  if (identityIds.length === 0) return []
  const placeholders = identityIds.map(() => '?').join(',')
  return queryAll<ReferenceSourceRow>(`
    SELECT i.id AS identity_id, i.display_name, a.raw_label, r.file_path, t.full_text
    FROM speaker_identities i
    JOIN speaker_aliases a ON a.identity_id = i.id
    JOIN speaker_occurrences o ON o.alias_id = a.id
    JOIN transcripts t ON t.id = o.transcript_id
    JOIN recordings r ON r.id = o.recording_id
    WHERE i.id IN (${placeholders}) AND i.status = 'confirmed' AND r.file_path IS NOT NULL
    ORDER BY i.is_self DESC, a.occurrence_count DESC, r.date_recorded DESC
  `, identityIds)
}

export async function createKnownSpeakerReferences(identityIds: string[]): Promise<KnownSpeakerReference[]> {
  const sources = referenceSources(identityIds)
  const references: KnownSpeakerReference[] = []
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'hidock-speaker-ref-'))
  try {
    for (const identityId of identityIds.slice(0, 4)) {
      const rows = sources.filter((row) => row.identity_id === identityId && existsSync(row.file_path))
      let created = false
      for (const row of rows) {
        const candidate = extractSpeakerReferenceCandidates(row.full_text, row.raw_label)[0]
        if (!candidate) continue
        const outputPath = join(temporaryDirectory, `${references.length}.wav`)
        try {
          await execFileAsync(process.env.FFMPEG_PATH?.trim() || 'ffmpeg', [
            '-hide_banner', '-loglevel', 'error',
            '-ss', candidate.startSeconds.toFixed(3),
            '-i', row.file_path,
            '-t', candidate.durationSeconds.toFixed(3),
            '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', outputPath
          ])
          const audio = await readFile(outputPath)
          references.push({
            identityId,
            name: row.display_name,
            dataUrl: `data:audio/wav;base64,${audio.toString('base64')}`
          })
          created = true
          break
        } catch {
          // Try another historical occurrence for this identity.
        }
      }
      if (!created) continue
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
  return references
}
