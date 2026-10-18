import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, renameSync } from 'fs'
import { basename, join } from 'path'
import {
  getDatabase,
  queryOne,
  runInTransaction,
  type Recording
} from './database'
import type {
  OtterReconciliationMatch,
  OtterReconciliationPreview
} from './otter-reconciliation'

export const OTTER_CANONICAL_MERGE_POLICY = 'accept-proposed-honor-saved-separate-v2'
export const OTTER_CANONICAL_MERGE_CONFIRMATION = 'MERGE PROPOSED OTTER MATCHES'

export interface OtterCanonicalMergeInventory {
  transcriptRecordingIds: Set<string>
  captureRecordingIds: Set<string>
  qualityRecordingIds: Set<string>
}
export interface OtterCanonicalMergeAction {
  importedRecordingId: string
  importedFilename: string
  deviceFilename: string
  deviceRecordedAt: string
  matchMethod: OtterReconciliationMatch['method']
  kind: 'canonicalize-imported' | 'consolidate-existing'
  canonicalRecordingId: string
  blockers: string[]
}

export interface OtterCanonicalMergePlan {
  generatedAt: string
  previewGeneratedAt: string
  policy: typeof OTTER_CANONICAL_MERGE_POLICY
  fingerprint: string
  ready: boolean
  counts: {
    proposedAccepted: number
    canonicalizeImported: number
    consolidateExisting: number
    unresolvedKeptSeparate: number
    preDevicePreserved: number
    blockers: number
  }
  actions: OtterCanonicalMergeAction[]
  unresolvedRecordingIds: string[]
  blockers: string[]
}

export interface OtterCanonicalMergeResult {
  batchId: string
  backupPath: string
  canonicalized: number
  consolidated: number
  keptSeparate: number
  archivedAudioPaths: string[]
}

interface ReviewRow {
  imported_recording_id: string
  device_filename: string | null
  decision: 'pending' | 'confirmed' | 'separate'
  match_method: string | null
  reviewed_at: string | null
  updated_at: string | null
}

function recordingBaseName(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').toLowerCase()
}

function fingerprintPlan(actions: OtterCanonicalMergeAction[], unresolvedRecordingIds: string[]): string {
  const value = {
    policy: OTTER_CANONICAL_MERGE_POLICY,
    actions: actions.map((action) => ({
      importedRecordingId: action.importedRecordingId,
      deviceFilename: action.deviceFilename,
      deviceRecordedAt: action.deviceRecordedAt,
      matchMethod: action.matchMethod,
      kind: action.kind,
      canonicalRecordingId: action.canonicalRecordingId
    })).sort((left, right) => left.importedRecordingId.localeCompare(right.importedRecordingId)),
    unresolvedRecordingIds: [...unresolvedRecordingIds].sort()
  }
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function buildOtterCanonicalMergePlan(
  preview: OtterReconciliationPreview,
  recordings: Recording[],
  inventory: OtterCanonicalMergeInventory,
  generatedAt = new Date().toISOString()
): OtterCanonicalMergePlan {
  const recordingsById = new Map(recordings.map((recording) => [recording.id, recording]))
  const recordingsByBase = new Map<string, Recording[]>()
  for (const recording of recordings) {
    const key = recordingBaseName(recording.filename)
    recordingsByBase.set(key, [...(recordingsByBase.get(key) || []), recording])
  }

  const globalBlockers: string[] = []
  const seenImports = new Set<string>()
  const seenDevices = new Set<string>()
  const actionableMatches = preview.matches.filter((match) => match.reviewDecision !== 'separate')
  const actions = actionableMatches.map((match): OtterCanonicalMergeAction => {
    const blockers: string[] = []
    const imported = recordingsById.get(match.importedRecordingId)
    if (!imported) blockers.push('Imported recording no longer exists.')
    if (imported && (imported.is_imported !== 1 || imported.source !== 'import')) {
      blockers.push('Source row is no longer an imported Otter recording.')
    }
    if (imported?.transcription_status === 'complete' && !inventory.transcriptRecordingIds.has(imported.id)) {
      blockers.push('Imported recording is marked complete but its transcript row is missing.')
    }
    if (seenImports.has(match.importedRecordingId)) blockers.push('Imported recording appears more than once in the plan.')
    if (seenDevices.has(recordingBaseName(match.deviceFilename))) {
      blockers.push('HiDock recording appears more than once in the plan.')
    }
    seenImports.add(match.importedRecordingId)
    seenDevices.add(recordingBaseName(match.deviceFilename))

    const existingTargets = (recordingsByBase.get(recordingBaseName(match.deviceFilename)) || [])
      .filter((recording) => recording.id !== match.importedRecordingId)
    if (existingTargets.length > 1) blockers.push('More than one existing recording owns the HiDock filename.')
    const target = existingTargets[0]
    const kind = target ? 'consolidate-existing' : 'canonicalize-imported'
    const canonicalRecordingId = target?.id || match.importedRecordingId

    if (target) {
      if (target.source !== 'hidock' || target.is_imported !== 0) {
        blockers.push('Existing basename owner is not a canonical HiDock recording.')
      }
      if (inventory.transcriptRecordingIds.has(target.id)) {
        blockers.push('Existing HiDock target already has a transcript.')
      }
      if (inventory.captureRecordingIds.has(target.id) && inventory.captureRecordingIds.has(match.importedRecordingId)) {
        blockers.push('Both source and target already have knowledge captures.')
      }
      if (inventory.qualityRecordingIds.has(target.id) && inventory.qualityRecordingIds.has(match.importedRecordingId)) {
        blockers.push('Both source and target already have quality assessments.')
      }
    }

    return {
      importedRecordingId: match.importedRecordingId,
      importedFilename: match.importedFilename,
      deviceFilename: match.deviceFilename,
      deviceRecordedAt: match.deviceRecordedAt,
      matchMethod: match.method,
      kind,
      canonicalRecordingId,
      blockers
    }
  })

  const unresolvedRecordingIds = preview.unresolved
    .filter((item) => item.reviewDecision !== 'separate')
    .map((item) => item.importedRecordingId)
  for (const id of unresolvedRecordingIds) {
    const recording = recordingsById.get(id)
    if (!recording || recording.is_imported !== 1 || recording.source !== 'import') {
      globalBlockers.push(`Unresolved Otter recording ${id} is no longer available for keep-separate classification.`)
    }
  }
  const blockers = [...globalBlockers, ...actions.flatMap((action) =>
    action.blockers.map((blocker) => `${action.importedFilename}: ${blocker}`))]
  if (actions.length === 0 && unresolvedRecordingIds.length === 0) {
    blockers.push('No new canonical merge work remains; saved keep-separate decisions are already honored.')
  }
  const fingerprint = fingerprintPlan(actions, unresolvedRecordingIds)
  return {
    generatedAt,
    previewGeneratedAt: preview.generatedAt,
    policy: OTTER_CANONICAL_MERGE_POLICY,
    fingerprint,
    ready: blockers.length === 0,
    counts: {
      proposedAccepted: actions.length,
      canonicalizeImported: actions.filter((action) => action.kind === 'canonicalize-imported').length,
      consolidateExisting: actions.filter((action) => action.kind === 'consolidate-existing').length,
      unresolvedKeptSeparate: unresolvedRecordingIds.length,
      preDevicePreserved: preview.counts.preDeviceOtterOnly,
      blockers: blockers.length
    },
    actions,
    unresolvedRecordingIds,
    blockers
  }
}

function recordingSnapshot(recording: Recording): Record<string, unknown> {
  return { ...recording }
}

function reviewFor(recordingId: string): ReviewRow | null {
  return queryOne<ReviewRow>(
    'SELECT * FROM otter_reconciliation_reviews WHERE imported_recording_id = ?',
    [recordingId]
  ) || null
}

function upsertReview(
  recordingId: string,
  deviceFilename: string | null,
  decision: 'confirmed' | 'separate',
  matchMethod: string | null,
  now: string
): void {
  getDatabase().run(`
    INSERT INTO otter_reconciliation_reviews
      (imported_recording_id, device_filename, decision, match_method, reviewed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(imported_recording_id) DO UPDATE SET
      device_filename = excluded.device_filename,
      decision = excluded.decision,
      match_method = excluded.match_method,
      reviewed_at = excluded.reviewed_at,
      updated_at = excluded.updated_at
  `, [recordingId, deviceFilename, decision, matchMethod, now, now])
}

function uniqueArchivePath(archiveRoot: string, batchId: string, sourcePath: string): string {
  const directory = join(archiveRoot, batchId)
  mkdirSync(directory, { recursive: true })
  const sourceName = basename(sourcePath)
  let candidate = join(directory, sourceName)
  let suffix = 1
  while (existsSync(candidate)) {
    suffix += 1
    const dot = sourceName.lastIndexOf('.')
    candidate = dot > 0
      ? join(directory, `${sourceName.slice(0, dot)}-${suffix}${sourceName.slice(dot)}`)
      : join(directory, `${sourceName}-${suffix}`)
  }
  return candidate
}

export function applyOtterCanonicalMerge(
  plan: OtterCanonicalMergePlan,
  recordings: Recording[],
  backupPath: string,
  archiveRoot: string,
  now = new Date().toISOString(),
  batchId: string = randomUUID()
): OtterCanonicalMergeResult {
  if (!plan.ready || plan.blockers.length > 0) throw new Error('The canonical merge plan has unresolved blockers.')
  if (plan.fingerprint !== fingerprintPlan(plan.actions, plan.unresolvedRecordingIds)) {
    throw new Error('The canonical merge plan fingerprint is invalid.')
  }

  const recordingsById = new Map(recordings.map((recording) => [recording.id, recording]))
  const stagedMoves: Array<{ from: string; to: string }> = []
  const archivePathByImportId = new Map<string, string>()
  try {
    for (const action of plan.actions.filter((item) => item.kind === 'consolidate-existing')) {
      const imported = recordingsById.get(action.importedRecordingId)
      if (!imported?.file_path || !existsSync(imported.file_path)) continue
      const archivePath = uniqueArchivePath(archiveRoot, batchId, imported.file_path)
      renameSync(imported.file_path, archivePath)
      stagedMoves.push({ from: imported.file_path, to: archivePath })
      archivePathByImportId.set(imported.id, archivePath)
    }

    runInTransaction(() => {
      const database = getDatabase()
      database.run(`
        INSERT INTO otter_reconciliation_merge_batches
          (id, status, policy, plan_fingerprint, preview_generated_at, backup_path, plan_json, applied_at)
        VALUES (?, 'applied', ?, ?, ?, ?, ?, ?)
      `, [
        batchId,
        plan.policy,
        plan.fingerprint,
        plan.previewGeneratedAt,
        backupPath,
        JSON.stringify(plan),
        now
      ])

      for (const action of plan.actions) {
        const imported = queryOne<Recording>('SELECT * FROM recordings WHERE id = ?', [action.importedRecordingId])
        if (!imported || imported.is_imported !== 1 || imported.source !== 'import') {
          throw new Error(`Imported recording changed before merge: ${action.importedFilename}`)
        }
        const beforeReview = reviewFor(imported.id)
        let afterRecording: Recording

        if (action.kind === 'canonicalize-imported') {
          const collision = queryOne<Recording>(
            'SELECT * FROM recordings WHERE id <> ? AND lower(filename) IN (?, ?, ?)',
            [
              imported.id,
              action.deviceFilename.toLowerCase(),
              action.deviceFilename.replace(/\.hda$/i, '.mp3').toLowerCase(),
              action.deviceFilename.replace(/\.hda$/i, '.wav').toLowerCase()
            ]
          )
          if (collision) throw new Error(`HiDock target appeared before merge: ${action.deviceFilename}`)
          database.run(`
            UPDATE recordings SET
              original_filename = COALESCE(original_filename, filename),
              filename = ?, date_recorded = ?, source_date_precision = 'exact',
              source_date_evidence = ?, location = CASE WHEN on_local = 1 THEN 'both' ELSE 'device-only' END,
              on_device = 1, device_last_seen = ?, source = 'hidock', is_imported = 0
            WHERE id = ?
          `, [
            action.deviceFilename,
            action.deviceRecordedAt,
            `hidock-device;otter-reconciliation:${action.matchMethod}`,
            now,
            imported.id
          ])
          upsertReview(imported.id, action.deviceFilename, 'confirmed', action.matchMethod, now)
          afterRecording = queryOne<Recording>('SELECT * FROM recordings WHERE id = ?', [imported.id])!
        } else {
          const target = queryOne<Recording>('SELECT * FROM recordings WHERE id = ?', [action.canonicalRecordingId])
          if (!target) throw new Error(`Existing HiDock target disappeared: ${action.deviceFilename}`)
          if (queryOne<{ id: string }>('SELECT id FROM transcripts WHERE recording_id = ?', [target.id])) {
            throw new Error(`Existing HiDock target gained a transcript: ${action.deviceFilename}`)
          }
          database.run('UPDATE transcripts SET recording_id = ? WHERE recording_id = ?', [target.id, imported.id])
          database.run('UPDATE transcription_history SET recording_id = ? WHERE recording_id = ?', [target.id, imported.id])
          database.run('UPDATE transcription_queue SET recording_id = ? WHERE recording_id = ?', [target.id, imported.id])
          database.run('UPDATE knowledge_captures SET source_recording_id = ? WHERE source_recording_id = ?', [target.id, imported.id])
          database.run('UPDATE quality_assessments SET recording_id = ? WHERE recording_id = ?', [target.id, imported.id])
          database.run(`
            DELETE FROM recording_meeting_candidates
            WHERE recording_id = ? AND meeting_id IN (
              SELECT meeting_id FROM recording_meeting_candidates WHERE recording_id = ?
            )
          `, [imported.id, target.id])
          database.run(
            'UPDATE recording_meeting_candidates SET recording_id = ? WHERE recording_id = ?',
            [target.id, imported.id]
          )
          database.run(`
            UPDATE recordings SET
              transcription_status = ?, status = ?,
              migrated_to_capture_id = COALESCE(migrated_to_capture_id, ?),
              meeting_id = COALESCE(meeting_id, ?),
              correlation_confidence = COALESCE(correlation_confidence, ?),
              correlation_method = COALESCE(correlation_method, ?),
              date_recorded = ?, source_date_precision = 'exact',
              source_date_evidence = ?, on_device = 1, device_last_seen = ?,
              source = 'hidock', is_imported = 0
            WHERE id = ?
          `, [
            imported.transcription_status,
            imported.status,
            imported.migrated_to_capture_id ?? null,
            imported.meeting_id ?? null,
            imported.correlation_confidence ?? null,
            imported.correlation_method ?? null,
            action.deviceRecordedAt,
            `hidock-device;otter-reconciliation:${action.matchMethod}`,
            now,
            target.id
          ])
          database.run('DELETE FROM otter_reconciliation_reviews WHERE imported_recording_id = ?', [imported.id])
          database.run('DELETE FROM recordings WHERE id = ?', [imported.id])
          afterRecording = queryOne<Recording>('SELECT * FROM recordings WHERE id = ?', [target.id])!
        }

        database.run(`
          INSERT INTO otter_reconciliation_merge_audit
            (id, batch_id, recording_id, canonical_recording_id, action, device_filename, match_method,
             before_recording_json, after_recording_json, before_review_json, archived_audio_path,
             status, applied_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?)
        `, [
          randomUUID(),
          batchId,
          imported.id,
          afterRecording.id,
          'canonicalized',
          action.deviceFilename,
          action.matchMethod,
          JSON.stringify(action.kind === 'consolidate-existing'
            ? { imported: recordingSnapshot(imported), canonical: recordingSnapshot(recordingsById.get(action.canonicalRecordingId)!) }
            : { imported: recordingSnapshot(imported) }),
          JSON.stringify({ canonical: recordingSnapshot(afterRecording) }),
          beforeReview ? JSON.stringify(beforeReview) : null,
          archivePathByImportId.get(imported.id) || null,
          now
        ])
      }

      for (const recordingId of plan.unresolvedRecordingIds) {
        const recording = queryOne<Recording>('SELECT * FROM recordings WHERE id = ?', [recordingId])
        if (!recording || recording.is_imported !== 1 || recording.source !== 'import') {
          throw new Error(`Keep-separate recording changed before merge: ${recordingId}`)
        }
        const beforeReview = reviewFor(recordingId)
        upsertReview(recordingId, null, 'separate', null, now)
        database.run(`
          INSERT INTO otter_reconciliation_merge_audit
            (id, batch_id, recording_id, canonical_recording_id, action, before_recording_json,
             after_recording_json, before_review_json, status, applied_at)
          VALUES (?, ?, ?, ?, 'kept-separate', ?, ?, ?, 'applied', ?)
        `, [
          randomUUID(), batchId, recordingId, recordingId,
          JSON.stringify({ imported: recordingSnapshot(recording) }),
          JSON.stringify({ canonical: recordingSnapshot(recording) }),
          beforeReview ? JSON.stringify(beforeReview) : null,
          now
        ])
      }
    })
  } catch (error) {
    for (const move of stagedMoves.reverse()) {
      try {
        if (existsSync(move.to) && !existsSync(move.from)) renameSync(move.to, move.from)
      } catch {
        // The portable safety backup remains the authoritative recovery path.
      }
    }
    throw error
  }

  return {
    batchId,
    backupPath,
    canonicalized: plan.counts.canonicalizeImported,
    consolidated: plan.counts.consolidateExisting,
    keptSeparate: plan.counts.unresolvedKeptSeparate,
    archivedAudioPaths: [...archivePathByImportId.values()]
  }
}
