/**
 * @vitest-environment node
 */

import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

import {
  applyPendingPortableRestore,
  createPortableBackup,
  renamePortablePathWithRetry,
  stagePortableRestore,
  validatePortableBackup
} from '../portable-backup'

const testRoots: string[] = []

function createFixture(): {
  root: string
  destination: string
  sources: { databasePath: string; recordingsPath: string; transcriptsPath: string }
} {
  const root = mkdtempSync(join(process.cwd(), '.portable-backup-test-'))
  testRoots.push(root)
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  const databasePath = join(source, 'data', 'hidock.db')
  const recordingsPath = join(source, 'recordings')
  const transcriptsPath = join(source, 'transcripts')
  mkdirSync(join(source, 'data'), { recursive: true })
  mkdirSync(recordingsPath, { recursive: true })
  mkdirSync(transcriptsPath, { recursive: true })
  mkdirSync(destination, { recursive: true })
  writeFileSync(databasePath, 'database-with-transcripts-and-speakers')
  writeFileSync(join(recordingsPath, '2026Oct16-102913-Rec21.mp3'), 'audio-bytes')
  writeFileSync(join(transcriptsPath, 'notes.txt'), 'future-sidecar')
  const sourceDate = new Date('2026-10-16T15:29:13.000Z')
  utimesSync(join(recordingsPath, '2026Oct16-102913-Rec21.mp3'), sourceDate, sourceDate)
  return { root, destination, sources: { databasePath, recordingsPath, transcriptsPath } }
}

afterEach(() => {
  for (const root of testRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('portable backup', () => {
  it('retries brief Windows rename locks before committing a backup', async () => {
    const rename = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EPERM' }))
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))
      .mockResolvedValue(undefined)

    await renamePortablePathWithRetry('partial', 'complete', rename, [0, 0])

    expect(rename).toHaveBeenCalledTimes(3)
  })

  it('does not retry permanent rename failures', async () => {
    const error = Object.assign(new Error('destination missing'), { code: 'ENOENT' })
    const rename = vi.fn<() => Promise<void>>().mockRejectedValue(error)

    await expect(renamePortablePathWithRetry('partial', 'complete', rename, [0])).rejects.toBe(error)
    expect(rename).toHaveBeenCalledTimes(1)
  })

  it('creates and validates a complete checksummed backup while preserving source mtimes', async () => {
    const fixture = createFixture()
    const now = new Date('2026-10-18T17:00:00.000Z')
    const result = await createPortableBackup(fixture.destination, fixture.sources, now)
    const validation = await validatePortableBackup(result.backupPath)

    expect(validation).toMatchObject({ valid: true, fileCount: 3, createdAt: now.toISOString() })
    expect(result.manifest.contents).toEqual({
      database: true,
      recordings: true,
      transcriptSidecars: true,
      apiKeysIncluded: false
    })
    expect(result.manifest.files.map((file) => file.path)).toEqual([
      'data/hidock.db',
      'recordings/2026Oct16-102913-Rec21.mp3',
      'transcripts/notes.txt'
    ])
    expect(statSync(join(result.backupPath, 'recordings', '2026Oct16-102913-Rec21.mp3')).mtime.toISOString())
      .toBe('2026-10-16T15:29:13.000Z')
  })

  it('detects changed files before restore', async () => {
    const fixture = createFixture()
    const result = await createPortableBackup(fixture.destination, fixture.sources)
    writeFileSync(join(result.backupPath, 'data', 'hidock.db'), 'tampered')

    const validation = await validatePortableBackup(result.backupPath)

    expect(validation.valid).toBe(false)
    expect(validation.errors).toEqual(expect.arrayContaining([
      'Size mismatch: data/hidock.db',
      'Checksum mismatch: data/hidock.db'
    ]))
  })

  it('rejects manifest paths that escape the backup folder', async () => {
    const fixture = createFixture()
    const result = await createPortableBackup(fixture.destination, fixture.sources)
    const manifestPath = join(result.backupPath, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    manifest.files[0].path = '../outside.db'
    writeFileSync(manifestPath, JSON.stringify(manifest))

    const validation = await validatePortableBackup(result.backupPath)

    expect(validation.valid).toBe(false)
    expect(validation.errors).toContain('Manifest path escapes the backup folder: ../outside.db')
  })

  it('refuses a destination inside the live recordings folder', async () => {
    const fixture = createFixture()

    await expect(createPortableBackup(fixture.sources.recordingsPath, fixture.sources)).rejects.toThrow(
      'Choose a backup destination outside the HiDock recordings and transcripts folders.'
    )
  })

  it('stages without changing live data, then replaces it at the restart boundary', async () => {
    const fixture = createFixture()
    const backup = await createPortableBackup(fixture.destination, fixture.sources)
    const liveRoot = join(fixture.root, 'live')
    mkdirSync(join(liveRoot, 'data'), { recursive: true })
    mkdirSync(join(liveRoot, 'recordings'), { recursive: true })
    mkdirSync(join(liveRoot, 'transcripts'), { recursive: true })
    writeFileSync(join(liveRoot, 'data', 'hidock.db'), 'current-database')
    writeFileSync(join(liveRoot, 'recordings', 'current.mp3'), 'current-audio')
    writeFileSync(join(liveRoot, 'transcripts', 'current.txt'), 'current-transcript')

    const safetyBackupPath = join(fixture.root, 'safety-backup')
    const staged = await stagePortableRestore(backup.backupPath, liveRoot, safetyBackupPath)

    expect(readFileSync(join(liveRoot, 'data', 'hidock.db'), 'utf-8')).toBe('current-database')
    expect(existsSync(join(liveRoot, 'recordings', 'current.mp3'))).toBe(true)
    expect(staged.validation.valid).toBe(true)
    expect(existsSync(join(liveRoot, 'pending-restore.json'))).toBe(true)

    const applied = await applyPendingPortableRestore(liveRoot)

    expect(applied).toEqual({ applied: true, restoredFiles: 3, safetyBackupPath })
    expect(readFileSync(join(liveRoot, 'data', 'hidock.db'), 'utf-8'))
      .toBe('database-with-transcripts-and-speakers')
    expect(existsSync(join(liveRoot, 'recordings', 'current.mp3'))).toBe(false)
    expect(readFileSync(join(liveRoot, 'recordings', '2026Oct16-102913-Rec21.mp3'), 'utf-8'))
      .toBe('audio-bytes')
    expect(statSync(join(liveRoot, 'recordings', '2026Oct16-102913-Rec21.mp3')).mtime.toISOString())
      .toBe('2026-10-16T15:29:13.000Z')
    expect(existsSync(join(liveRoot, 'pending-restore.json'))).toBe(false)
    expect(existsSync(join(liveRoot, 'last-restore.json'))).toBe(true)
  })

  it('quarantines a tampered staged restore and leaves the live library unchanged', async () => {
    const fixture = createFixture()
    const backup = await createPortableBackup(fixture.destination, fixture.sources)
    const liveRoot = join(fixture.root, 'live')
    mkdirSync(join(liveRoot, 'data'), { recursive: true })
    mkdirSync(join(liveRoot, 'recordings'), { recursive: true })
    mkdirSync(join(liveRoot, 'transcripts'), { recursive: true })
    writeFileSync(join(liveRoot, 'data', 'hidock.db'), 'current-database')
    writeFileSync(join(liveRoot, 'recordings', 'current.mp3'), 'current-audio')

    const staged = await stagePortableRestore(backup.backupPath, liveRoot, join(fixture.root, 'safety-backup'))
    writeFileSync(join(staged.stagedBackupPath, 'data', 'hidock.db'), 'tampered-after-staging')

    await expect(applyPendingPortableRestore(liveRoot)).rejects.toThrow('Pending restore validation failed')

    expect(readFileSync(join(liveRoot, 'data', 'hidock.db'), 'utf-8')).toBe('current-database')
    expect(readFileSync(join(liveRoot, 'recordings', 'current.mp3'), 'utf-8')).toBe('current-audio')
    expect(existsSync(join(liveRoot, 'pending-restore.json'))).toBe(false)
    expect(readdirSync(liveRoot).some((name) => name.startsWith('failed-restore-'))).toBe(true)
  })

  it('does nothing when no restore is pending', async () => {
    const fixture = createFixture()
    expect(await applyPendingPortableRestore(join(fixture.root, 'unused-live'))).toEqual({ applied: false })
  })
})
