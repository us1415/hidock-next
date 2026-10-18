import { BrowserWindow, dialog, ipcMain } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { getRecordings, getTranscriptsByRecordingIds, queryAll, runMany, saveDatabase } from '../services/database'
import { getRecordingsPath } from '../services/file-storage'
import { getDataPath } from '../services/config'
import { createPortableBackup } from '../services/portable-backup'
import { commitOtterImport, previewOtterImport, type ExistingOtterCandidate } from '../services/otter-import'
import {
  buildOtterReconciliationPreview,
  type OtterReconciliationDecision,
  type OtterReconciliationReview,
  type ReconciliationDeviceFile
} from '../services/otter-reconciliation'
import {
  applyOtterCanonicalMerge,
  buildOtterCanonicalMergePlan,
  OTTER_CANONICAL_MERGE_CONFIRMATION,
  type OtterCanonicalMergeInventory,
  type OtterCanonicalMergePlan
} from '../services/otter-canonical-merge'
import {
  getWatcherStatus,
  startRecordingWatcher,
  stopRecordingWatcher
} from '../services/recording-watcher'

function getExistingOtterCandidates(): ExistingOtterCandidate[] {
  const recordings = getRecordings()
  const transcripts = getTranscriptsByRecordingIds(recordings.map((recording) => recording.id))
  return recordings.map((recording) => ({
    recordingId: recording.id,
    filename: recording.filename,
    originalFilename: recording.original_filename,
    fileSize: recording.file_size,
    recordedAt: recording.date_recorded,
    transcriptText: transcripts.get(recording.id)?.full_text
  }))
}

async function getOtterReconciliationPreview() {
  const deviceFiles = queryAll<ReconciliationDeviceFile>(
    'SELECT filename, size, duration, dateCreated FROM device_file_cache ORDER BY dateCreated'
  )
  const reviews = queryAll<OtterReconciliationReview>(`
    SELECT
      imported_recording_id AS importedRecordingId,
      device_filename AS deviceFilename,
      decision,
      match_method AS matchMethod,
      reviewed_at AS reviewedAt
    FROM otter_reconciliation_reviews
  `)
  return buildOtterReconciliationPreview(
    getRecordings(),
    deviceFiles,
    undefined,
    new Date().toISOString(),
    reviews
  )
}

function getOtterCanonicalMergeInventory(): OtterCanonicalMergeInventory {
  return {
    transcriptRecordingIds: new Set(
      queryAll<{ recording_id: string }>('SELECT recording_id FROM transcripts').map((row) => row.recording_id)
    ),
    captureRecordingIds: new Set(
      queryAll<{ source_recording_id: string }>(
        'SELECT source_recording_id FROM knowledge_captures WHERE source_recording_id IS NOT NULL'
      ).map((row) => row.source_recording_id)
    ),
    qualityRecordingIds: new Set(
      queryAll<{ recording_id: string }>('SELECT recording_id FROM quality_assessments').map((row) => row.recording_id)
    )
  }
}

async function getOtterCanonicalMergePlan(): Promise<OtterCanonicalMergePlan> {
  const preview = await getOtterReconciliationPreview()
  return buildOtterCanonicalMergePlan(preview, getRecordings(), getOtterCanonicalMergeInventory())
}

export function registerImportHandlers(): void {
  ipcMain.handle('imports:preview-otter-reconciliation', async () => {
    try {
      const preview = await getOtterReconciliationPreview()
      return { success: true, preview }
    } catch (error) {
      console.error('imports:preview-otter-reconciliation error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'The Otter-to-HiDock reconciliation preview failed.'
      }
    }
  })

  ipcMain.handle('imports:preview-otter-canonical-merge', async () => {
    try {
      const plan = await getOtterCanonicalMergePlan()
      return { success: true, plan }
    } catch (error) {
      console.error('imports:preview-otter-canonical-merge error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'The canonical merge dry run failed.'
      }
    }
  })

  ipcMain.handle('imports:apply-otter-canonical-merge', async (_, value: unknown) => {
    const request = value && typeof value === 'object' ? value as Record<string, unknown> : null
    if (!request || request.confirmation !== OTTER_CANONICAL_MERGE_CONFIRMATION ||
        typeof request.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(request.fingerprint)) {
      return { success: false, error: 'The canonical merge confirmation is invalid.' }
    }

    try {
      const plan = await getOtterCanonicalMergePlan()
      if (!plan.ready) return { success: false, error: 'The canonical merge dry run has blockers.', plan }
      if (plan.fingerprint !== request.fingerprint) {
        return { success: false, error: 'The library changed after the dry run. Generate a new plan before merging.' }
      }

      saveDatabase()
      const safetyParent = join(getDataPath(), 'merge-safety')
      mkdirSync(safetyParent, { recursive: true })
      const safetyBackup = await createPortableBackup(safetyParent)
      const watcherWasRunning = getWatcherStatus().isWatching
      if (watcherWasRunning) stopRecordingWatcher()
      try {
        const result = applyOtterCanonicalMerge(
          plan,
          getRecordings(),
          safetyBackup.backupPath,
          join(getDataPath(), 'reconciliation-archive')
        )
        return { success: true, result }
      } finally {
        if (watcherWasRunning) startRecordingWatcher()
      }
    } catch (error) {
      console.error('imports:apply-otter-canonical-merge error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'The canonical merge failed.'
      }
    }
  })

  ipcMain.handle('imports:save-otter-reconciliation-reviews', async (_, value: unknown) => {
    try {
      if (!Array.isArray(value) || value.length === 0 || value.length > 1000) {
        return { success: false, error: 'The reconciliation review selection is invalid.' }
      }
      const decisions = new Set<OtterReconciliationDecision>(['pending', 'confirmed', 'separate'])
      const methods = new Set(['exact-timestamp', 'date-duration', 'adjacent-date-duration'])
      const seen = new Set<string>()
      const rows: Array<[string, string | null, OtterReconciliationDecision, string | null, string | null]> = []
      const importedIds = new Set(
        getRecordings()
          .filter((recording) => recording.is_imported === 1 && recording.source === 'import')
          .map((recording) => recording.id)
      )
      const deviceFilenames = new Set(
        queryAll<{ filename: string }>('SELECT filename FROM device_file_cache').map((item) => item.filename)
      )

      for (const item of value) {
        if (!item || typeof item !== 'object') {
          return { success: false, error: 'A reconciliation review item is invalid.' }
        }
        const candidate = item as Record<string, unknown>
        const importedRecordingId = candidate.importedRecordingId
        const decision = candidate.decision
        const deviceFilename = candidate.deviceFilename
        const matchMethod = candidate.matchMethod
        if (typeof importedRecordingId !== 'string' || importedRecordingId.length > 200 ||
            !importedIds.has(importedRecordingId) || seen.has(importedRecordingId) ||
            typeof decision !== 'string' || !decisions.has(decision as OtterReconciliationDecision)) {
          return { success: false, error: 'A reconciliation review item is invalid or duplicated.' }
        }
        if (decision === 'confirmed' &&
            (typeof deviceFilename !== 'string' || !deviceFilenames.has(deviceFilename) ||
             typeof matchMethod !== 'string' || !methods.has(matchMethod))) {
          return { success: false, error: 'A confirmed reconciliation match is missing valid HiDock evidence.' }
        }
        seen.add(importedRecordingId)
        rows.push([
          importedRecordingId,
          decision === 'confirmed' ? deviceFilename as string : null,
          decision as OtterReconciliationDecision,
          decision === 'confirmed' ? matchMethod as string : null,
          decision === 'pending' ? null : new Date().toISOString()
        ])
      }

      runMany(`
        INSERT INTO otter_reconciliation_reviews
          (imported_recording_id, device_filename, decision, match_method, reviewed_at, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(imported_recording_id) DO UPDATE SET
          device_filename = excluded.device_filename,
          decision = excluded.decision,
          match_method = excluded.match_method,
          reviewed_at = excluded.reviewed_at,
          updated_at = CURRENT_TIMESTAMP
      `, rows)
      return { success: true, saved: rows.length }
    } catch (error) {
      console.error('imports:save-otter-reconciliation-reviews error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'The reconciliation review decisions could not be saved.'
      }
    }
  })

  ipcMain.handle('imports:preview-otter', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow()
      const options = {
        title: 'Choose an Otter ZIP export to inspect',
        filters: [{ name: 'Otter ZIP Export', extensions: ['zip'] }],
        properties: ['openFile'] as Array<'openFile'>
      }
      const selection = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      if (selection.canceled || !selection.filePaths[0]) return { success: false, canceled: true }

      const preview = await previewOtterImport(selection.filePaths[0], getExistingOtterCandidates())
      return { success: true, preview }
    } catch (error) {
      console.error('imports:preview-otter error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'The Otter export could not be inspected.'
      }
    }
  })

  ipcMain.handle('imports:commit-otter', async (_, archivePath: unknown, selectedKeys: unknown) => {
    try {
      if (typeof archivePath !== 'string' || !archivePath.toLowerCase().endsWith('.zip')) {
        return { success: false, error: 'The selected Otter ZIP path is invalid.' }
      }
      if (!Array.isArray(selectedKeys) || selectedKeys.length === 0 || selectedKeys.length > 10000 ||
          selectedKeys.some((key) => typeof key !== 'string' || key.length === 0 || key.length > 1000)) {
        return { success: false, error: 'The Otter import selection is invalid.' }
      }

      // A real import can add gigabytes and hundreds of database rows. Capture
      // the current library first so the user always has a pre-import restore point.
      saveDatabase()
      const safetyParent = join(getDataPath(), 'import-safety')
      mkdirSync(safetyParent, { recursive: true })
      const safetyBackup = await createPortableBackup(safetyParent)

      // The import writes collision-safe physical filenames that intentionally
      // differ from the source filenames stored in the database. Pause the live
      // watcher while those files are moved into place so it cannot claim one
      // before the import transaction commits.
      const watcherWasRunning = getWatcherStatus().isWatching
      if (watcherWasRunning) stopRecordingWatcher()

      try {
        const result = await commitOtterImport(
          archivePath,
          getRecordingsPath(),
          selectedKeys as string[],
          getExistingOtterCandidates()
        )
        return { success: true, result, safetyBackupPath: safetyBackup.backupPath }
      } finally {
        if (watcherWasRunning) startRecordingWatcher()
      }
    } catch (error) {
      console.error('imports:commit-otter error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'The Otter export could not be imported.'
      }
    }
  })
}
