import { BrowserWindow, dialog, ipcMain } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { getRecordings, getTranscriptsByRecordingIds, queryAll, saveDatabase } from '../services/database'
import { getRecordingsPath } from '../services/file-storage'
import { getDataPath } from '../services/config'
import { createPortableBackup } from '../services/portable-backup'
import { commitOtterImport, previewOtterImport, type ExistingOtterCandidate } from '../services/otter-import'
import {
  buildOtterReconciliationPreview,
  type ReconciliationDeviceFile
} from '../services/otter-reconciliation'
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

export function registerImportHandlers(): void {
  ipcMain.handle('imports:preview-otter-reconciliation', async () => {
    try {
      const deviceFiles = queryAll<ReconciliationDeviceFile>(
        'SELECT filename, size, duration, dateCreated FROM device_file_cache ORDER BY dateCreated'
      )
      const preview = await buildOtterReconciliationPreview(getRecordings(), deviceFiles)
      return { success: true, preview }
    } catch (error) {
      console.error('imports:preview-otter-reconciliation error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'The Otter-to-HiDock reconciliation preview failed.'
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
