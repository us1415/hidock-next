import { randomUUID } from 'crypto'
import { getDatabase, queryAll, queryOne, runInTransaction } from './database'

export interface SpeakerAlias {
  id: string
  identityId: string | null
  rawLabel: string
  normalizedLabel: string
  occurrenceCount: number
  firstSeenAt: string | null
  lastSeenAt: string | null
}

export interface SpeakerIdentity {
  id: string
  displayName: string
  status: 'needs-review' | 'confirmed'
  contactId: string | null
  firstSeenAt: string | null
  lastSeenAt: string | null
  occurrenceCount: number
  aliases: SpeakerAlias[]
}

export interface SpeakerOverview {
  identities: SpeakerIdentity[]
  unresolvedAliases: SpeakerAlias[]
  counts: {
    identities: number
    confirmed: number
    needsReview: number
    unresolvedAliases: number
    rawLabels: number
    transcriptOccurrences: number
    speakerSegments: number
  }
}

interface TranscriptSpeakerRow {
  transcript_id: string
  recording_id: string
  full_text: string
  speakers: string | null
  date_recorded: string
}

interface IdentityRow {
  id: string
  canonical_key: string
  display_name: string
  contact_id: string | null
  status: 'needs-review' | 'confirmed'
  first_seen_at: string | null
  last_seen_at: string | null
}

interface AliasRow {
  id: string
  identity_id: string | null
  raw_label: string
  normalized_label: string
  occurrence_count: number
  first_seen_at: string | null
  last_seen_at: string | null
}

const GENERIC_SPEAKER = /^(?:unknown(?: speaker)?|speaker\s*\d+|speaker|multiple speakers?|unidentified|participant\s*\d+)$/i
const SPEAKER_HEADER = /^(.+?)\s{2,}(?:(?:\d{1,2}):)?\d{2}:\d{2}$/

export function normalizeSpeakerLabel(value: string): { displayName: string; canonicalKey: string; generic: boolean } {
  const displayName = value.normalize('NFKC').trim().replace(/\s+/g, ' ').replace(/:+$/, '').trim()
  const canonicalKey = displayName.toLocaleLowerCase('en-US')
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  return { displayName, canonicalKey, generic: !canonicalKey || GENERIC_SPEAKER.test(displayName) }
}

function parseSpeakerLabels(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim()).filter(Boolean))]
      : []
  } catch {
    return []
  }
}

function countSegments(fullText: string, label: string): number {
  let count = 0
  for (const line of fullText.split(/\r?\n/)) {
    const match = line.trim().match(SPEAKER_HEADER)
    if (match?.[1].trim() === label) count++
  }
  return count
}

export function rebuildSpeakerIndex(now = new Date().toISOString()): SpeakerOverview {
  const rows = queryAll<TranscriptSpeakerRow>(`
    SELECT t.id AS transcript_id, t.recording_id, t.full_text, t.speakers, r.date_recorded
    FROM transcripts t
    JOIN recordings r ON r.id = t.recording_id
    WHERE t.speakers IS NOT NULL AND t.speakers != ''
  `)

  runInTransaction(() => {
    const database = getDatabase()
    database.run('DELETE FROM speaker_occurrences')
    database.run('UPDATE speaker_aliases SET occurrence_count = 0, first_seen_at = NULL, last_seen_at = NULL')

    for (const row of rows) {
      for (const rawLabel of parseSpeakerLabels(row.speakers)) {
        const normalized = normalizeSpeakerLabel(rawLabel)
        let alias = queryOne<AliasRow>(
          "SELECT * FROM speaker_aliases WHERE raw_label = ? AND source = 'transcript'",
          [rawLabel]
        )

        if (!alias) {
          let identityId: string | null = null
          if (!normalized.generic) {
            let identity = queryOne<IdentityRow>('SELECT * FROM speaker_identities WHERE canonical_key = ?', [normalized.canonicalKey])
            if (!identity) {
              identityId = randomUUID()
              database.run(`
                INSERT INTO speaker_identities
                  (id, canonical_key, display_name, status, first_seen_at, last_seen_at, created_at, updated_at)
                VALUES (?, ?, ?, 'needs-review', ?, ?, ?, ?)
              `, [identityId, normalized.canonicalKey, normalized.displayName, row.date_recorded, row.date_recorded, now, now])
            } else {
              identityId = identity.id
            }
          }
          const aliasId = randomUUID()
          database.run(`
            INSERT INTO speaker_aliases
              (id, identity_id, raw_label, normalized_label, source, occurrence_count,
               first_seen_at, last_seen_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'transcript', 0, NULL, NULL, ?, ?)
          `, [aliasId, identityId, rawLabel, normalized.canonicalKey, now, now])
          alias = queryOne<AliasRow>('SELECT * FROM speaker_aliases WHERE id = ?', [aliasId])!
        }

        const segmentCount = countSegments(row.full_text, rawLabel)
        database.run(`
          INSERT INTO speaker_occurrences
            (id, transcript_id, recording_id, alias_id, segment_count, recorded_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [randomUUID(), row.transcript_id, row.recording_id, alias.id, segmentCount, row.date_recorded, now])
      }
    }

    database.run(`
      UPDATE speaker_aliases SET
        occurrence_count = COALESCE((SELECT COUNT(*) FROM speaker_occurrences o WHERE o.alias_id = speaker_aliases.id), 0),
        first_seen_at = (SELECT MIN(recorded_at) FROM speaker_occurrences o WHERE o.alias_id = speaker_aliases.id),
        last_seen_at = (SELECT MAX(recorded_at) FROM speaker_occurrences o WHERE o.alias_id = speaker_aliases.id),
        updated_at = ?
    `, [now])
    database.run(`
      UPDATE speaker_identities SET
        first_seen_at = (SELECT MIN(first_seen_at) FROM speaker_aliases a WHERE a.identity_id = speaker_identities.id),
        last_seen_at = (SELECT MAX(last_seen_at) FROM speaker_aliases a WHERE a.identity_id = speaker_identities.id),
        updated_at = ?
    `, [now])
  })

  return getSpeakerOverview()
}

export function getSpeakerOverview(): SpeakerOverview {
  const identities = queryAll<IdentityRow>('SELECT * FROM speaker_identities ORDER BY display_name COLLATE NOCASE')
  const aliases = queryAll<AliasRow>('SELECT * FROM speaker_aliases ORDER BY occurrence_count DESC, raw_label COLLATE NOCASE')
  const mappedAliases = aliases.map((alias): SpeakerAlias => ({
    id: alias.id,
    identityId: alias.identity_id,
    rawLabel: alias.raw_label,
    normalizedLabel: alias.normalized_label,
    occurrenceCount: alias.occurrence_count,
    firstSeenAt: alias.first_seen_at,
    lastSeenAt: alias.last_seen_at
  }))
  const speakerIdentities = identities.map((identity): SpeakerIdentity => {
    const identityAliases = mappedAliases.filter((alias) => alias.identityId === identity.id)
    return {
      id: identity.id,
      displayName: identity.display_name,
      status: identity.status,
      contactId: identity.contact_id,
      firstSeenAt: identity.first_seen_at,
      lastSeenAt: identity.last_seen_at,
      occurrenceCount: identityAliases.reduce((total, alias) => total + alias.occurrenceCount, 0),
      aliases: identityAliases
    }
  })
  const occurrenceTotals = queryOne<{ occurrences: number; segments: number }>(`
    SELECT COUNT(*) AS occurrences, COALESCE(SUM(segment_count), 0) AS segments FROM speaker_occurrences
  `) || { occurrences: 0, segments: 0 }
  return {
    identities: speakerIdentities,
    unresolvedAliases: mappedAliases.filter((alias) => alias.identityId === null),
    counts: {
      identities: speakerIdentities.length,
      confirmed: speakerIdentities.filter((identity) => identity.status === 'confirmed').length,
      needsReview: speakerIdentities.filter((identity) => identity.status === 'needs-review').length,
      unresolvedAliases: mappedAliases.filter((alias) => alias.identityId === null).length,
      rawLabels: mappedAliases.length,
      transcriptOccurrences: occurrenceTotals.occurrences,
      speakerSegments: occurrenceTotals.segments
    }
  }
}

export function renameSpeakerIdentity(identityId: string, displayName: string, now = new Date().toISOString()): SpeakerIdentity {
  const normalized = normalizeSpeakerLabel(displayName)
  if (!normalized.displayName || normalized.generic) throw new Error('Enter a specific person name.')
  const existing = queryOne<IdentityRow>('SELECT * FROM speaker_identities WHERE id = ?', [identityId])
  if (!existing) throw new Error('Speaker identity not found.')
  const collision = queryOne<IdentityRow>('SELECT * FROM speaker_identities WHERE canonical_key = ? AND id <> ?', [normalized.canonicalKey, identityId])
  if (collision) throw new Error(`That name already belongs to ${collision.display_name}; merge the identities instead.`)
  runInTransaction(() => {
    getDatabase().run(
      "UPDATE speaker_identities SET display_name = ?, canonical_key = ?, status = 'confirmed', updated_at = ? WHERE id = ?",
      [normalized.displayName, normalized.canonicalKey, now, identityId]
    )
  })
  return getSpeakerOverview().identities.find((identity) => identity.id === identityId)!
}

export function confirmAllSpeakerIdentities(now = new Date().toISOString()): SpeakerOverview {
  runInTransaction(() => {
    getDatabase().run(
      "UPDATE speaker_identities SET status = 'confirmed', updated_at = ? WHERE status = 'needs-review'",
      [now]
    )
  })
  return getSpeakerOverview()
}

export function mergeSpeakerIdentities(sourceId: string, targetId: string, now = new Date().toISOString()): SpeakerIdentity {
  if (sourceId === targetId) throw new Error('Choose two different speaker identities.')
  const source = queryOne<IdentityRow>('SELECT * FROM speaker_identities WHERE id = ?', [sourceId])
  const target = queryOne<IdentityRow>('SELECT * FROM speaker_identities WHERE id = ?', [targetId])
  if (!source || !target) throw new Error('Speaker identity not found.')
  runInTransaction(() => {
    const database = getDatabase()
    database.run('UPDATE speaker_aliases SET identity_id = ?, updated_at = ? WHERE identity_id = ?', [targetId, now, sourceId])
    database.run(`
      UPDATE speaker_identities SET
        status = 'confirmed',
        first_seen_at = (SELECT MIN(first_seen_at) FROM speaker_aliases WHERE identity_id = ?),
        last_seen_at = (SELECT MAX(last_seen_at) FROM speaker_aliases WHERE identity_id = ?),
        updated_at = ?
      WHERE id = ?
    `, [targetId, targetId, now, targetId])
    database.run('DELETE FROM speaker_identities WHERE id = ?', [sourceId])
  })
  return getSpeakerOverview().identities.find((identity) => identity.id === targetId)!
}

export function assignSpeakerAlias(aliasId: string, identityId: string, now = new Date().toISOString()): SpeakerIdentity {
  const alias = queryOne<AliasRow>('SELECT * FROM speaker_aliases WHERE id = ?', [aliasId])
  const identity = queryOne<IdentityRow>('SELECT * FROM speaker_identities WHERE id = ?', [identityId])
  if (!alias || !identity) throw new Error('Speaker alias or identity not found.')
  if (normalizeSpeakerLabel(alias.raw_label).generic) {
    throw new Error('Generic labels vary by recording and cannot be assigned globally.')
  }
  runInTransaction(() => {
    const database = getDatabase()
    database.run('UPDATE speaker_aliases SET identity_id = ?, updated_at = ? WHERE id = ?', [identityId, now, aliasId])
    database.run(`
      UPDATE speaker_identities SET
        status = 'confirmed',
        first_seen_at = (SELECT MIN(first_seen_at) FROM speaker_aliases WHERE identity_id = ?),
        last_seen_at = (SELECT MAX(last_seen_at) FROM speaker_aliases WHERE identity_id = ?),
        updated_at = ?
      WHERE id = ?
    `, [identityId, identityId, now, identityId])
  })
  return getSpeakerOverview().identities.find((item) => item.id === identityId)!
}
