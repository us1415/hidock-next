import { createHash, randomUUID } from 'crypto'
import {
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { rename as renameAsync } from 'fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import { getDatabasePath, getRecordingsPath, getTranscriptsPath } from './file-storage'

export interface PortableBackupFile {
  path: string
  size: number
  modifiedAt: string
  sha256: string
}

export interface PortableBackupManifest {
  format: 'hidock-next-portable-backup'
  schemaVersion: 1
  createdAt: string
  contents: {
    database: boolean
    recordings: boolean
    transcriptSidecars: boolean
    apiKeysIncluded: false
  }
  files: PortableBackupFile[]
}

export interface PortableBackupValidation {
  valid: boolean
  errors: string[]
  warnings: string[]
  fileCount: number
  totalBytes: number
  createdAt?: string
}

interface PendingPortableRestore {
  format: 'hidock-next-pending-restore'
  schemaVersion: 1
  stagedBackupPath: string
  safetyBackupPath: string
  requestedAt: string
}

interface BackupSourcePaths {
  databasePath: string
  recordingsPath: string
  transcriptsPath: string
}

export class PortableRestoreRollbackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PortableRestoreRollbackError'
  }
}

const PORTABLE_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200]
const RETRYABLE_WINDOWS_RENAME_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM'])

type RenameOperation = (source: string, destination: string) => Promise<void>

/**
 * Retry brief Windows file-lock failures without hiding permanent filesystem errors.
 * The operation parameter is a test seam; production callers use fs/promises.rename.
 */
export async function renamePortablePathWithRetry(
  source: string,
  destination: string,
  operation: RenameOperation = renameAsync,
  retryDelaysMs: readonly number[] = PORTABLE_RENAME_RETRY_DELAYS_MS
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await operation(source, destination)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!code || !RETRYABLE_WINDOWS_RENAME_ERRORS.has(code) || attempt >= retryDelaysMs.length) throw error
      await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelaysMs[attempt]))
    }
  }
}

function defaultSourcePaths(): BackupSourcePaths {
  return {
    databasePath: getDatabasePath(),
    recordingsPath: getRecordingsPath(),
    transcriptsPath: getTranscriptsPath()
  }
}

function portablePath(value: string): string {
  return value.split(sep).join('/')
}

async function sha256File(filePath: string): Promise<string> {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

async function copyBackupFile(source: string, destination: string, packageRoot: string): Promise<PortableBackupFile> {
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
  const sourceStats = statSync(source)
  utimesSync(destination, sourceStats.atime, sourceStats.mtime)
  return {
    path: portablePath(relative(packageRoot, destination)),
    size: sourceStats.size,
    modifiedAt: sourceStats.mtime.toISOString(),
    sha256: await sha256File(destination)
  }
}

async function copyDirectoryFiles(sourceRoot: string, destinationRoot: string, packageRoot: string): Promise<PortableBackupFile[]> {
  if (!existsSync(sourceRoot)) return []
  const files: PortableBackupFile[] = []

  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    const source = join(sourceRoot, entry.name)
    const destination = join(destinationRoot, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      files.push(...await copyDirectoryFiles(source, destination, packageRoot))
    } else if (entry.isFile()) {
      files.push(await copyBackupFile(source, destination, packageRoot))
    }
  }

  return files
}

function backupFolderName(date: Date): string {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `hidock-next-backup-${stamp}`
}

function uniqueBackupPath(parentDirectory: string, date: Date): string {
  const name = backupFolderName(date)
  let candidate = join(parentDirectory, name)
  let suffix = 1
  while (existsSync(candidate)) {
    suffix += 1
    candidate = join(parentDirectory, `${name}-${suffix}`)
  }
  return candidate
}

function isPathInside(candidate: string, parent: string): boolean {
  const resolvedCandidate = resolve(candidate)
  const resolvedParent = resolve(parent)
  return resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(`${resolvedParent}${sep}`)
}

export async function createPortableBackup(
  parentDirectory: string,
  sources: BackupSourcePaths = defaultSourcePaths(),
  now = new Date()
): Promise<{ backupPath: string; manifest: PortableBackupManifest }> {
  if (!existsSync(parentDirectory) || !statSync(parentDirectory).isDirectory()) {
    throw new Error('Backup destination is not a directory.')
  }
  if (!existsSync(sources.databasePath) || !statSync(sources.databasePath).isFile()) {
    throw new Error('HiDock database was not found.')
  }
  if (isPathInside(parentDirectory, sources.recordingsPath) || isPathInside(parentDirectory, sources.transcriptsPath)) {
    throw new Error('Choose a backup destination outside the HiDock recordings and transcripts folders.')
  }

  const backupPath = uniqueBackupPath(parentDirectory, now)
  const partialPath = `${backupPath}.partial-${randomUUID()}`
  mkdirSync(partialPath, { recursive: true })

  try {
    const files: PortableBackupFile[] = []
    files.push(await copyBackupFile(sources.databasePath, join(partialPath, 'data', 'hidock.db'), partialPath))
    const recordings = await copyDirectoryFiles(
      sources.recordingsPath,
      join(partialPath, 'recordings'),
      partialPath
    )
    const transcriptSidecars = await copyDirectoryFiles(
      sources.transcriptsPath,
      join(partialPath, 'transcripts'),
      partialPath
    )
    files.push(...recordings, ...transcriptSidecars)
    files.sort((a, b) => a.path.localeCompare(b.path))

    const manifest: PortableBackupManifest = {
      format: 'hidock-next-portable-backup',
      schemaVersion: 1,
      createdAt: now.toISOString(),
      contents: {
        database: true,
        recordings: recordings.length > 0,
        transcriptSidecars: transcriptSidecars.length > 0,
        apiKeysIncluded: false
      },
      files
    }
    writeFileSync(join(partialPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
    await renamePortablePathWithRetry(partialPath, backupPath)
    return { backupPath, manifest }
  } catch (error) {
    if (existsSync(partialPath)) rmSync(partialPath, { recursive: true, force: true })
    throw error
  }
}

function resolveManifestFile(backupPath: string): { root: string; manifestPath: string } {
  const resolved = resolve(backupPath)
  if (basename(resolved).toLowerCase() === 'manifest.json') {
    return { root: dirname(resolved), manifestPath: resolved }
  }
  return { root: resolved, manifestPath: join(resolved, 'manifest.json') }
}

function resolveContainedPath(root: string, manifestPath: string): string {
  const resolvedRoot = resolve(root)
  const resolvedFile = resolve(root, ...manifestPath.split('/'))
  if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Manifest path escapes the backup folder: ${manifestPath}`)
  }
  return resolvedFile
}

export async function validatePortableBackup(backupPath: string): Promise<PortableBackupValidation> {
  const errors: string[] = []
  const warnings: string[] = []
  let manifest: PortableBackupManifest
  let root: string

  try {
    const resolved = resolveManifestFile(backupPath)
    root = resolved.root
    if (statSync(resolved.manifestPath).size > 10 * 1024 * 1024) throw new Error('Backup manifest is too large.')
    manifest = JSON.parse(readFileSync(resolved.manifestPath, 'utf-8')) as PortableBackupManifest
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : 'Backup manifest could not be read.'],
      warnings,
      fileCount: 0,
      totalBytes: 0
    }
  }

  if (manifest.format !== 'hidock-next-portable-backup') errors.push('Unsupported backup format.')
  if (manifest.schemaVersion !== 1) errors.push(`Unsupported backup schema version: ${manifest.schemaVersion}`)
  if (!Array.isArray(manifest.files)) errors.push('Backup manifest file list is invalid.')
  if (Array.isArray(manifest.files) && manifest.files.length > 100000) errors.push('Backup contains too many files.')
  if (errors.length > 0) {
    return { valid: false, errors, warnings, fileCount: 0, totalBytes: 0, createdAt: manifest.createdAt }
  }

  let totalBytes = 0
  for (const file of manifest.files) {
    try {
      const filePath = resolveContainedPath(root, file.path)
      if (!existsSync(filePath) || lstatSync(filePath).isSymbolicLink() || !statSync(filePath).isFile()) {
        errors.push(`Missing file: ${file.path}`)
        continue
      }
      const stats = statSync(filePath)
      totalBytes += stats.size
      if (stats.size !== file.size) errors.push(`Size mismatch: ${file.path}`)
      if (await sha256File(filePath) !== file.sha256) errors.push(`Checksum mismatch: ${file.path}`)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `Could not validate: ${file.path}`)
    }
  }

  if (!manifest.files.some((file) => file.path === 'data/hidock.db')) {
    errors.push('Backup does not contain data/hidock.db.')
  }
  if (!manifest.contents.apiKeysIncluded) {
    warnings.push('API keys are intentionally excluded and must be configured separately after restore.')
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    fileCount: manifest.files.length,
    totalBytes,
    createdAt: manifest.createdAt
  }
}

function readPortableManifest(backupPath: string): { root: string; manifest: PortableBackupManifest } {
  const resolved = resolveManifestFile(backupPath)
  return {
    root: resolved.root,
    manifest: JSON.parse(readFileSync(resolved.manifestPath, 'utf-8')) as PortableBackupManifest
  }
}

function copyFilePreservingTimes(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
  const stats = statSync(source)
  utimesSync(destination, stats.atime, stats.mtime)
}

function pendingRestorePath(dataPath: string): string {
  return join(dataPath, 'pending-restore.json')
}

export async function stagePortableRestore(
  backupPath: string,
  dataPath: string,
  safetyBackupPath: string,
  now = new Date()
): Promise<{ stagedBackupPath: string; validation: PortableBackupValidation }> {
  const sourceValidation = await validatePortableBackup(backupPath)
  if (!sourceValidation.valid) {
    throw new Error(`Backup validation failed: ${sourceValidation.errors[0] || 'unknown error'}`)
  }
  const markerPath = pendingRestorePath(dataPath)
  if (existsSync(markerPath)) throw new Error('A restore is already pending.')

  const { root: sourceRoot, manifest } = readPortableManifest(backupPath)
  const stagingParent = join(dataPath, 'restore-staging')
  const stagedBackupPath = join(stagingParent, randomUUID())
  mkdirSync(stagedBackupPath, { recursive: true })

  try {
    for (const file of manifest.files) {
      copyFilePreservingTimes(
        resolveContainedPath(sourceRoot, file.path),
        resolveContainedPath(stagedBackupPath, file.path)
      )
    }
    writeFileSync(join(stagedBackupPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
    const stagedValidation = await validatePortableBackup(stagedBackupPath)
    if (!stagedValidation.valid) {
      throw new Error(`Staged backup validation failed: ${stagedValidation.errors[0] || 'unknown error'}`)
    }

    const marker: PendingPortableRestore = {
      format: 'hidock-next-pending-restore',
      schemaVersion: 1,
      stagedBackupPath,
      safetyBackupPath,
      requestedAt: now.toISOString()
    }
    const markerTemp = `${markerPath}.tmp-${randomUUID()}`
    writeFileSync(markerTemp, `${JSON.stringify(marker, null, 2)}\n`, 'utf-8')
    await renamePortablePathWithRetry(markerTemp, markerPath)
    return { stagedBackupPath, validation: stagedValidation }
  } catch (error) {
    if (existsSync(stagedBackupPath)) rmSync(stagedBackupPath, { recursive: true, force: true })
    throw error
  }
}

function assertStagedPath(dataPath: string, stagedBackupPath: string): void {
  const stagingRoot = join(dataPath, 'restore-staging')
  if (!isPathInside(stagedBackupPath, stagingRoot) || resolve(stagedBackupPath) === resolve(stagingRoot)) {
    throw new Error('Pending restore points outside protected staging storage.')
  }
}

export async function applyPendingPortableRestore(dataPath: string): Promise<{
  applied: boolean
  restoredFiles?: number
  safetyBackupPath?: string
}> {
  const markerPath = pendingRestorePath(dataPath)
  if (!existsSync(markerPath)) return { applied: false }

  const operationId = randomUUID()
  let marker: PendingPortableRestore
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf-8')) as PendingPortableRestore
    if (marker.format !== 'hidock-next-pending-restore' || marker.schemaVersion !== 1) {
      throw new Error('Pending restore marker is invalid.')
    }
    assertStagedPath(dataPath, marker.stagedBackupPath)
    const stagedValidation = await validatePortableBackup(marker.stagedBackupPath)
    if (!stagedValidation.valid) {
      throw new Error(`Pending restore validation failed: ${stagedValidation.errors[0] || 'unknown error'}`)
    }
  } catch (error) {
    try {
      renameSync(markerPath, join(dataPath, `failed-restore-${operationId}.json`))
    } catch {
      // Preserve the validation error even if quarantine cannot be completed.
    }
    throw error
  }

  const workRoot = join(dataPath, `.restore-work-${operationId}`)
  const previousRoot = join(dataPath, `.restore-previous-${operationId}`)
  const liveDatabase = join(dataPath, 'data', 'hidock.db')
  const liveRecordings = join(dataPath, 'recordings')
  const liveTranscripts = join(dataPath, 'transcripts')
  const replacements = [
    { live: liveDatabase, prepared: join(workRoot, 'data', 'hidock.db'), previous: join(previousRoot, 'data', 'hidock.db') },
    { live: liveRecordings, prepared: join(workRoot, 'recordings'), previous: join(previousRoot, 'recordings') },
    { live: liveTranscripts, prepared: join(workRoot, 'transcripts'), previous: join(previousRoot, 'transcripts') }
  ]

  const movedPrevious: typeof replacements = []
  const installed: typeof replacements = []
  let committed = false

  const restorePreviousData = (): void => {
    for (const replacement of [...installed].reverse()) {
      if (existsSync(replacement.live)) rmSync(replacement.live, { recursive: true, force: true })
    }
    for (const replacement of [...movedPrevious].reverse()) {
      if (existsSync(replacement.previous)) {
        mkdirSync(dirname(replacement.live), { recursive: true })
        renameSync(replacement.previous, replacement.live)
      }
    }
  }

  const quarantineMarker = (): void => {
    if (!existsSync(markerPath)) return
    const failedPath = join(dataPath, `failed-restore-${operationId}.json`)
    renameSync(markerPath, failedPath)
  }

  mkdirSync(join(workRoot, 'data'), { recursive: true })
  mkdirSync(join(workRoot, 'recordings'), { recursive: true })
  mkdirSync(join(workRoot, 'transcripts'), { recursive: true })
  const { root: stagedRoot, manifest } = readPortableManifest(marker.stagedBackupPath)
  try {
    for (const file of manifest.files) {
      copyFilePreservingTimes(
        resolveContainedPath(stagedRoot, file.path),
        resolveContainedPath(workRoot, file.path)
      )
    }
    writeFileSync(join(workRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
    const preparedValidation = await validatePortableBackup(workRoot)
    if (!preparedValidation.valid) {
      throw new Error(`Prepared restore validation failed: ${preparedValidation.errors[0] || 'unknown error'}`)
    }

    mkdirSync(previousRoot, { recursive: true })
    for (const replacement of replacements) {
      if (existsSync(replacement.live)) {
        mkdirSync(dirname(replacement.previous), { recursive: true })
        renameSync(replacement.live, replacement.previous)
        movedPrevious.push(replacement)
      }
    }
    for (const replacement of replacements) {
      mkdirSync(dirname(replacement.live), { recursive: true })
      renameSync(replacement.prepared, replacement.live)
      installed.push(replacement)
    }

    // Renaming the marker is the commit boundary. A completed restore cannot be
    // accidentally replayed if later best-effort cleanup is interrupted.
    const completedMarkerPath = join(dataPath, 'last-restore.json')
    if (existsSync(completedMarkerPath)) rmSync(completedMarkerPath, { force: true })
    renameSync(markerPath, completedMarkerPath)
    committed = true

    for (const cleanupPath of [previousRoot, workRoot, marker.stagedBackupPath]) {
      try {
        rmSync(cleanupPath, { recursive: true, force: true })
      } catch {
        // The restore is already committed. Leftover recovery folders are safer
        // than treating successful data replacement as a failed restore.
      }
    }
    return {
      applied: true,
      restoredFiles: manifest.files.length,
      safetyBackupPath: marker.safetyBackupPath
    }
  } catch (error) {
    let rollbackError: unknown
    if (!committed) {
      try {
        restorePreviousData()
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure
      }
      try {
        quarantineMarker()
      } catch {
        // Preserve the original error; startup will still stop rather than use
        // data whose restore state is uncertain.
      }
    }
    try {
      if (existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true })
    } catch {
      // Keep the primary restore/rollback failure.
    }
    if (rollbackError) {
      const primary = error instanceof Error ? error.message : 'Restore failed.'
      const rollback = rollbackError instanceof Error ? rollbackError.message : 'Rollback failed.'
      throw new PortableRestoreRollbackError(`${primary} Rollback also failed: ${rollback}`)
    }
    throw error
  }
}
