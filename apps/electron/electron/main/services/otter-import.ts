import { createHash, randomUUID } from 'crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, utimesSync } from 'fs'
import { basename, join } from 'path'
import { pipeline } from 'stream/promises'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import { importOtterRecordsAtomically, type OtterDatabaseImportItem } from './database'

const MAX_ARCHIVE_ENTRIES = 10000
const MAX_TEXT_ENTRY_BYTES = 20 * 1024 * 1024
const TRANSCRIPT_SUFFIX = '_transcript.txt'
const SUMMARY_SUFFIX = '_summary.txt'

const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11
}

export interface ExistingOtterCandidate {
  recordingId: string
  filename: string
  originalFilename?: string
  fileSize?: number
  recordedAt?: string
  transcriptText?: string
}

export type OtterDateEvidence = 'filename-timestamp' | 'filename-date' | 'summary-date' | 'unknown'
export type OtterSourceDatePrecision = 'exact' | 'date-only' | 'unknown'
export type OtterImportItemStatus = 'ready' | 'date-review' | 'missing-transcript' | 'duplicate'

export interface OtterImportPreviewItem {
  key: string
  title: string
  audioFilename: string
  audioBytes: number
  recordedAt: string | null
  recordedDate: string | null
  sourceDatePrecision: OtterSourceDatePrecision
  dateEvidence: OtterDateEvidence
  transcriptAvailable: boolean
  summaryAvailable: boolean
  speakers: string[]
  status: OtterImportItemStatus
  duplicateRecordingId?: string
  duplicateReason?: 'filename' | 'audio-metadata' | 'transcript' | 'archive-transcript'
}

export interface OtterImportPreview {
  archivePath: string
  archiveFilename: string
  archiveBytes: number
  scannedAt: string
  counts: {
    total: number
    ready: number
    dateReview: number
    missingTranscript: number
    duplicate: number
    audioFiles: number
    transcriptFiles: number
    summaryFiles: number
    uniqueSpeakers: number
  }
  speakers: string[]
  items: OtterImportPreviewItem[]
}

export interface OtterImportCommitResult {
  imported: number
  withTranscripts: number
  audioOnly: number
  importedRecordingIds: string[]
}

interface ArchiveGroup {
  stem: string
  audio?: Entry
  transcript?: Entry
  summary?: Entry
  transcriptText?: string
  summaryText?: string
}

interface ParsedDate {
  recordedAt: string | null
  recordedDate: string | null
  evidence: OtterDateEvidence
}

function openZip(archivePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      archivePath,
      { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true, strictFileNames: true },
      (error, zipFile) => {
        if (error || !zipFile) reject(error || new Error('Otter archive could not be opened.'))
        else resolve(zipFile)
      }
    )
  })
}

function readTextEntry(zipFile: ZipFile, entry: Entry): Promise<string> {
  if (entry.uncompressedSize > MAX_TEXT_ENTRY_BYTES) {
    return Promise.reject(new Error(`Text entry is too large: ${entry.fileName}`))
  }
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error || new Error(`Could not read ${entry.fileName}`))
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > MAX_TEXT_ENTRY_BYTES) {
          stream.destroy(new Error(`Text entry is too large: ${entry.fileName}`))
          return
        }
        chunks.push(chunk)
      })
      stream.on('error', reject)
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    })
  })
}

function entryKind(fileName: string): { stem: string; kind: 'audio' | 'transcript' | 'summary' } | null {
  if (fileName.includes('\0') || fileName.split('/').includes('..')) {
    throw new Error(`Unsafe path in Otter archive: ${fileName}`)
  }
  if (fileName.endsWith(TRANSCRIPT_SUFFIX)) {
    return { stem: fileName.slice(0, -TRANSCRIPT_SUFFIX.length), kind: 'transcript' }
  }
  if (fileName.endsWith(SUMMARY_SUFFIX)) {
    return { stem: fileName.slice(0, -SUMMARY_SUFFIX.length), kind: 'summary' }
  }
  if (fileName.toLowerCase().endsWith('.mp3')) {
    return { stem: fileName.slice(0, -4), kind: 'audio' }
  }
  return null
}

async function readArchiveGroups(archivePath: string): Promise<Map<string, ArchiveGroup>> {
  const zipFile = await openZip(archivePath)
  const groups = new Map<string, ArchiveGroup>()

  return await new Promise((resolve, reject) => {
    let settled = false
    let entryCount = 0
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      zipFile.close()
      reject(error)
    }

    zipFile.on('error', fail)
    zipFile.on('end', () => {
      if (settled) return
      settled = true
      zipFile.close()
      resolve(groups)
    })
    zipFile.on('entry', async (entry) => {
      try {
        entryCount += 1
        if (entryCount > MAX_ARCHIVE_ENTRIES) throw new Error('Otter archive contains too many entries.')
        const identified = entryKind(entry.fileName)
        if (identified) {
          const group = groups.get(identified.stem) || { stem: identified.stem }
          if (group[identified.kind]) throw new Error(`Duplicate Otter archive entry: ${entry.fileName}`)
          group[identified.kind] = entry
          if (identified.kind === 'transcript') group.transcriptText = await readTextEntry(zipFile, entry)
          if (identified.kind === 'summary') group.summaryText = await readTextEntry(zipFile, entry)
          groups.set(identified.stem, group)
        }
        zipFile.readEntry()
      } catch (error) {
        fail(error)
      }
    })
    zipFile.readEntry()
  })
}

function localIso(year: number, month: number, day: number, hour: number, minute: number, second: number): string | null {
  const value = new Date(year, month, day, hour, minute, second)
  if (
    value.getFullYear() !== year ||
    value.getMonth() !== month ||
    value.getDate() !== day ||
    value.getHours() !== hour ||
    value.getMinutes() !== minute ||
    value.getSeconds() !== second
  ) {
    return null
  }
  return value.toISOString()
}

function dateOnly(year: number, month: number, day: number): string | null {
  const value = new Date(year, month, day)
  if (value.getFullYear() !== year || value.getMonth() !== month || value.getDate() !== day) return null
  return `${year.toString().padStart(4, '0')}-${(month + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
}

export function parseOtterSourceDate(stem: string, summaryText?: string): ParsedDate {
  const namedTimestamp = stem.match(/(?:^|\/)(\d{4})(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(\d{2})-(\d{2})(\d{2})(\d{2})/)
  if (namedTimestamp) {
    const [, year, month, day, hour, minute, second] = namedTimestamp
    const recordedAt = localIso(+year, MONTHS[month], +day, +hour, +minute, +second)
    if (recordedAt) {
      return { recordedAt, recordedDate: dateOnly(+year, MONTHS[month], +day), evidence: 'filename-timestamp' }
    }
  }

  const numericTimestamp = stem.match(/(?:^|\/)(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/)
  if (numericTimestamp) {
    const [, year, month, day, hour, minute, second] = numericTimestamp
    const recordedAt = localIso(+year, +month - 1, +day, +hour, +minute, +second)
    if (recordedAt) {
      return { recordedAt, recordedDate: dateOnly(+year, +month - 1, +day), evidence: 'filename-timestamp' }
    }
  }

  const filenameDate = stem.match(/(?:^|\/)(\d{4})-(\d{2})-(\d{2})(?:_|\b)/)
    || stem.match(/(?:^|\/)(\d{4})(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(\d{2})(?:-|_|\b)/)
  if (filenameDate) {
    const month = filenameDate[2] in MONTHS ? MONTHS[filenameDate[2]] : +filenameDate[2] - 1
    const recordedDate = dateOnly(+filenameDate[1], month, +filenameDate[3])
    if (recordedDate) return { recordedAt: null, recordedDate, evidence: 'filename-date' }
  }

  for (const line of (summaryText || '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean).slice(0, 5)) {
    const match = line.match(/^(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})$/)
    if (!match) continue
    const month = Object.keys(MONTHS).findIndex((name) => match[1].startsWith(name))
    const recordedDate = dateOnly(+match[3], month, +match[2])
    if (recordedDate) return { recordedAt: null, recordedDate, evidence: 'summary-date' }
  }
  return { recordedAt: null, recordedDate: null, evidence: 'unknown' }
}

export function extractOtterSpeakers(transcriptText?: string): string[] {
  if (!transcriptText) return []
  const speakers = new Set<string>()
  for (const line of transcriptText.split(/\r?\n/)) {
    const match = line.trim().match(/^(.+?)\s{2,}(?:(?:\d{1,2}):)?\d{2}:\d{2}$/)
    if (match) speakers.add(match[1].trim())
  }
  return [...speakers].sort((a, b) => a.localeCompare(b))
}

function normalizedTextHash(value?: string): string | null {
  if (!value || value.trim().length < 200) return null
  const normalized = value.toLowerCase().replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(normalized).digest('hex')
}

function normalizedBase(value: string): string {
  return basename(value).replace(/\.[^.]+$/, '').trim().toLowerCase()
}

function summaryTitle(summaryText: string | undefined, fallback: string): string {
  return summaryText?.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || fallback
}

function findExistingDuplicate(
  group: ArchiveGroup,
  parsedDate: ParsedDate,
  existing: ExistingOtterCandidate[],
  existingTranscriptHashes: Map<string, string>
): Pick<OtterImportPreviewItem, 'duplicateRecordingId' | 'duplicateReason'> | null {
  const stem = normalizedBase(group.stem)
  const byName = existing.find((candidate) =>
    [candidate.filename, candidate.originalFilename].filter(Boolean).some((value) => normalizedBase(value!) === stem)
  )
  if (byName) return { duplicateRecordingId: byName.recordingId, duplicateReason: 'filename' }

  if (group.audio && parsedDate.recordedAt) {
    const sourceTime = new Date(parsedDate.recordedAt).getTime()
    const byMetadata = existing.find((candidate) => {
      if (candidate.fileSize !== group.audio!.uncompressedSize || !candidate.recordedAt) return false
      const candidateTime = new Date(candidate.recordedAt).getTime()
      return Number.isFinite(candidateTime) && Math.abs(candidateTime - sourceTime) <= 2 * 60 * 1000
    })
    if (byMetadata) return { duplicateRecordingId: byMetadata.recordingId, duplicateReason: 'audio-metadata' }
  }

  const transcriptHash = normalizedTextHash(group.transcriptText)
  const transcriptRecordingId = transcriptHash ? existingTranscriptHashes.get(transcriptHash) : undefined
  return transcriptRecordingId
    ? { duplicateRecordingId: transcriptRecordingId, duplicateReason: 'transcript' }
    : null
}

export async function previewOtterImport(
  archivePath: string,
  existing: ExistingOtterCandidate[] = [],
  now = new Date()
): Promise<OtterImportPreview> {
  const archiveStats = statSync(archivePath)
  if (!archiveStats.isFile() || !archivePath.toLowerCase().endsWith('.zip')) {
    throw new Error('Choose an Otter ZIP export.')
  }
  const groups = await readArchiveGroups(archivePath)
  const existingTranscriptHashes = new Map<string, string>()
  for (const candidate of existing) {
    const hash = normalizedTextHash(candidate.transcriptText)
    if (hash) existingTranscriptHashes.set(hash, candidate.recordingId)
  }
  const archiveTranscriptHashes = new Map<string, string>()
  const allSpeakers = new Set<string>()
  const items: OtterImportPreviewItem[] = []

  for (const group of [...groups.values()].filter((value) => value.audio).sort((a, b) => a.stem.localeCompare(b.stem))) {
    const parsedDate = parseOtterSourceDate(group.stem, group.summaryText)
    const speakers = extractOtterSpeakers(group.transcriptText)
    speakers.forEach((speaker) => allSpeakers.add(speaker))
    const existingDuplicate = findExistingDuplicate(group, parsedDate, existing, existingTranscriptHashes)
    const transcriptHash = normalizedTextHash(group.transcriptText)
    const archiveDuplicateKey = transcriptHash ? archiveTranscriptHashes.get(transcriptHash) : undefined
    let status: OtterImportItemStatus = 'ready'
    let duplicateReason: OtterImportPreviewItem['duplicateReason']
    let duplicateRecordingId: string | undefined

    if (!group.transcript) status = 'missing-transcript'
    else if (existingDuplicate) {
      status = 'duplicate'
      duplicateReason = existingDuplicate.duplicateReason
      duplicateRecordingId = existingDuplicate.duplicateRecordingId
    } else if (archiveDuplicateKey) {
      status = 'duplicate'
      duplicateReason = 'archive-transcript'
    } else if (!parsedDate.recordedAt) {
      status = 'date-review'
    }
    if (transcriptHash && !archiveDuplicateKey) archiveTranscriptHashes.set(transcriptHash, group.stem)

    items.push({
      key: group.stem,
      title: summaryTitle(group.summaryText, basename(group.stem).trim()),
      audioFilename: basename(group.audio!.fileName),
      audioBytes: group.audio!.uncompressedSize,
      recordedAt: parsedDate.recordedAt,
      recordedDate: parsedDate.recordedDate,
      sourceDatePrecision: parsedDate.recordedAt ? 'exact' : parsedDate.recordedDate ? 'date-only' : 'unknown',
      dateEvidence: parsedDate.evidence,
      transcriptAvailable: Boolean(group.transcript),
      summaryAvailable: Boolean(group.summary),
      speakers,
      status,
      duplicateRecordingId,
      duplicateReason
    })
  }

  return {
    archivePath,
    archiveFilename: basename(archivePath),
    archiveBytes: archiveStats.size,
    scannedAt: now.toISOString(),
    counts: {
      total: items.length,
      ready: items.filter((item) => item.status === 'ready').length,
      dateReview: items.filter((item) => item.status === 'date-review').length,
      missingTranscript: items.filter((item) => item.status === 'missing-transcript').length,
      duplicate: items.filter((item) => item.status === 'duplicate').length,
      audioFiles: [...groups.values()].filter((group) => group.audio).length,
      transcriptFiles: [...groups.values()].filter((group) => group.transcript).length,
      summaryFiles: [...groups.values()].filter((group) => group.summary).length,
      uniqueSpeakers: allSpeakers.size
    },
    speakers: [...allSpeakers].sort((a, b) => a.localeCompare(b)),
    items
  }
}

async function extractSelectedAudio(
  archivePath: string,
  targets: Map<string, string>,
  stagingDirectory: string
): Promise<void> {
  const zipFile = await openZip(archivePath)
  const pending = new Set(targets.keys())

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      zipFile.close()
      reject(error)
    }

    zipFile.on('error', fail)
    zipFile.on('end', () => {
      if (settled) return
      if (pending.size > 0) {
        fail(new Error(`Otter archive changed during import; ${pending.size} selected audio file(s) are missing.`))
        return
      }
      settled = true
      zipFile.close()
      resolve()
    })
    zipFile.on('entry', (entry) => {
      const stagedName = targets.get(entry.fileName)
      if (!stagedName) {
        zipFile.readEntry()
        return
      }
      zipFile.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          fail(error || new Error(`Could not extract ${entry.fileName}`))
          return
        }
        pipeline(stream, createWriteStream(join(stagingDirectory, stagedName), { flags: 'wx' }))
          .then(() => {
            pending.delete(entry.fileName)
            zipFile.readEntry()
          })
          .catch(fail)
      })
    })
    zipFile.readEntry()
  })
}

/**
 * Commit explicitly selected, non-duplicate Otter conversations. Audio is
 * extracted into a private staging directory, moved into place, and only then
 * inserted in a single database transaction. Any failure removes files created
 * by this attempt and leaves the database unchanged.
 */
export async function commitOtterImport(
  archivePath: string,
  recordingsDirectory: string,
  selectedKeys: string[],
  existing: ExistingOtterCandidate[] = []
): Promise<OtterImportCommitResult> {
  if (selectedKeys.length === 0) throw new Error('Select at least one Otter conversation to import.')
  if (new Set(selectedKeys).size !== selectedKeys.length) throw new Error('The Otter import selection contains duplicates.')

  const preview = await previewOtterImport(archivePath, existing)
  const previewByKey = new Map(preview.items.map((item) => [item.key, item]))
  const selected = selectedKeys.map((key) => {
    const item = previewByKey.get(key)
    if (!item) throw new Error(`Selected Otter conversation is no longer present: ${key}`)
    if (item.status === 'duplicate') throw new Error(`Selected Otter conversation is already imported: ${item.title}`)
    if (item.sourceDatePrecision === 'unknown' || (!item.recordedAt && !item.recordedDate)) {
      throw new Error(`Resolve the recording date before importing: ${item.title}`)
    }
    return item
  })

  const groups = await readArchiveGroups(archivePath)
  mkdirSync(recordingsDirectory, { recursive: true })
  const batchId = randomUUID()
  const stagingDirectory = join(recordingsDirectory, `.otter-import-${batchId}`)
  mkdirSync(stagingDirectory, { recursive: false })
  const movedFiles: string[] = []

  try {
    const prepared = selected.map((item, index) => {
      const group = groups.get(item.key)
      if (!group?.audio) throw new Error(`Selected Otter audio is missing: ${item.title}`)
      const recordingId = randomUUID()
      const safeOriginalName = basename(group.audio.fileName).replace(/[^a-zA-Z0-9._ -]/g, '_')
      const physicalName = `otter-${batchId.slice(0, 8)}-${index.toString().padStart(4, '0')}-${safeOriginalName}`
      return { item, group, recordingId, physicalName }
    })

    await extractSelectedAudio(
      archivePath,
      new Map(prepared.map(({ group, physicalName }) => [group.audio!.fileName, physicalName])),
      stagingDirectory
    )

    const databaseItems: OtterDatabaseImportItem[] = []
    for (const { item, group, recordingId, physicalName } of prepared) {
      const stagedPath = join(stagingDirectory, physicalName)
      const finalPath = join(recordingsDirectory, physicalName)
      if (existsSync(finalPath)) throw new Error(`Import destination already exists: ${physicalName}`)
      renameSync(stagedPath, finalPath)
      movedFiles.push(finalPath)

      if (item.recordedAt) {
        const timestamp = new Date(item.recordedAt)
        utimesSync(finalPath, timestamp, timestamp)
      }

      const transcriptText = group.transcriptText?.trim()
      const sourceDate = item.recordedAt || item.recordedDate!
      databaseItems.push({
        recording: {
          id: recordingId,
          filename: item.audioFilename,
          original_filename: item.audioFilename,
          file_path: finalPath,
          file_size: statSync(finalPath).size,
          duration_seconds: undefined,
          date_recorded: sourceDate,
          source_date_precision: item.sourceDatePrecision,
          source_date_evidence: `otter-${item.dateEvidence}`,
          meeting_id: undefined,
          correlation_confidence: undefined,
          correlation_method: undefined,
          status: 'ready',
          location: 'local-only',
          transcription_status: transcriptText ? 'complete' : 'none',
          on_device: 0,
          on_local: 1,
          source: 'import',
          is_imported: 1
        },
        transcript: transcriptText
          ? {
              id: randomUUID(),
              recording_id: recordingId,
              full_text: transcriptText,
              language: 'unknown',
              summary: group.summaryText?.trim(),
              speakers: JSON.stringify(item.speakers),
              word_count: transcriptText.split(/\s+/).filter(Boolean).length,
              transcription_provider: 'otter-import',
              transcription_model: 'otter-export',
              title_suggestion: item.title
            }
          : undefined
      })
    }

    importOtterRecordsAtomically(databaseItems)
    return {
      imported: databaseItems.length,
      withTranscripts: databaseItems.filter((item) => item.transcript).length,
      audioOnly: databaseItems.filter((item) => !item.transcript).length,
      importedRecordingIds: databaseItems.map((item) => item.recording.id)
    }
  } catch (error) {
    for (const filePath of movedFiles) {
      try { rmSync(filePath, { force: true }) } catch { /* best effort rollback */ }
    }
    throw error
  } finally {
    try { rmSync(stagingDirectory, { recursive: true, force: true }) } catch { /* best effort cleanup */ }
  }
}
