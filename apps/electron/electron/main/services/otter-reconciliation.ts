import { execFile } from 'child_process'
import { promisify } from 'util'
import type { Recording } from './database'

const execFileAsync = promisify(execFile)
const P1_BYTES_PER_SECOND = 12_000
const DURATION_MATCH_TOLERANCE_SECONDS = 5

export interface ReconciliationDeviceFile {
  filename: string
  size: number
  duration: number
  dateCreated: string | null
}

export interface OtterReconciliationMatch {
  importedRecordingId: string
  importedFilename: string
  deviceFilename: string
  deviceRecordedAt: string
  method: 'exact-timestamp' | 'date-duration' | 'adjacent-date-duration'
  confidence: number
  durationDifferenceSeconds?: number
}

export interface OtterReconciliationUnresolvedItem {
  importedRecordingId: string
  importedFilename: string
  recordedDate: string
  durationSeconds: number | null
  nearestCandidates: Array<{
    deviceFilename: string
    deviceRecordedAt: string
    durationDifferenceSeconds: number | null
  }>
}

export interface OtterReconciliationPreview {
  generatedAt: string
  deviceInventoryStart: string | null
  deviceInventoryEnd: string | null
  counts: {
    deviceRecordings: number
    importedOtter: number
    importedMissingTranscript: number
    importedMissingTranscriptUsableAudio: number
    importedMissingTranscriptUnusableAudio: number
    preDeviceOtterOnly: number
    overlappingOtter: number
    exactTimestampMatches: number
    dateDurationMatches: number
    adjacentDateDurationMatches: number
    provisionalMatches: number
    unresolvedOverlapping: number
    deviceWithoutOtterMatch: number
  }
  matches: OtterReconciliationMatch[]
  unresolved: OtterReconciliationUnresolvedItem[]
}

type DurationProvider = (filePath: string) => Promise<number>

function localCalendarDate(value: string): string | null {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const year = date.getFullYear().toString().padStart(4, '0')
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')
  return `${year}-${month}-${day}`
}

function recordingCalendarDate(recording: Recording): string | null {
  if (recording.source_date_precision === 'date-only') return /^\d{4}-\d{2}-\d{2}$/.test(recording.date_recorded)
    ? recording.date_recorded
    : null
  return localCalendarDate(recording.date_recorded)
}

function shiftCalendarDate(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return shifted.toISOString().slice(0, 10)
}

function deviceDurationSeconds(file: ReconciliationDeviceFile): number | null {
  if (Number.isFinite(file.size) && file.size > 0) return file.size / P1_BYTES_PER_SECOND
  if (Number.isFinite(file.duration) && file.duration > 0) return file.duration
  return null
}

export async function probeAudioDurationSeconds(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ], { windowsHide: true })
  const duration = Number.parseFloat(stdout.trim())
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Could not read audio duration: ${filePath}`)
  return duration
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await mapper(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  return results
}

export async function buildOtterReconciliationPreview(
  recordings: Recording[],
  deviceFiles: ReconciliationDeviceFile[],
  durationProvider: DurationProvider = probeAudioDurationSeconds,
  generatedAt = new Date().toISOString()
): Promise<OtterReconciliationPreview> {
  const imported = recordings.filter((recording) => recording.is_imported === 1 && recording.source === 'import')
  const datedDeviceFiles = deviceFiles
    .filter((file): file is ReconciliationDeviceFile & { dateCreated: string } =>
      typeof file.dateCreated === 'string' && !Number.isNaN(new Date(file.dateCreated).getTime()))
    .sort((left, right) => new Date(left.dateCreated).getTime() - new Date(right.dateCreated).getTime())
  const inventoryStart = datedDeviceFiles[0]?.dateCreated ?? null
  const inventoryEnd = datedDeviceFiles.at(-1)?.dateCreated ?? null
  const inventoryStartDate = inventoryStart ? localCalendarDate(inventoryStart) : null

  const preDevice: Recording[] = []
  const overlapping: Recording[] = []
  for (const recording of imported) {
    const date = recordingCalendarDate(recording)
    if (!inventoryStartDate || !date || date < inventoryStartDate) preDevice.push(recording)
    else overlapping.push(recording)
  }

  const devicesByTimestamp = new Map<number, ReconciliationDeviceFile[]>()
  for (const file of datedDeviceFiles) {
    const timestamp = new Date(file.dateCreated).getTime()
    const values = devicesByTimestamp.get(timestamp) || []
    values.push(file)
    devicesByTimestamp.set(timestamp, values)
  }

  const usedDeviceFiles = new Set<string>()
  const matchedImports = new Set<string>()
  const matches: OtterReconciliationMatch[] = []
  for (const recording of overlapping.filter((item) => item.source_date_precision === 'exact')) {
    const candidates = devicesByTimestamp.get(new Date(recording.date_recorded).getTime()) || []
    const device = candidates.find((candidate) => !usedDeviceFiles.has(candidate.filename))
    if (!device || !device.dateCreated) continue
    usedDeviceFiles.add(device.filename)
    matchedImports.add(recording.id)
    matches.push({
      importedRecordingId: recording.id,
      importedFilename: recording.filename,
      deviceFilename: device.filename,
      deviceRecordedAt: device.dateCreated,
      method: 'exact-timestamp',
      confidence: 1
    })
  }

  const missingTranscript = imported.filter((recording) => recording.transcription_status !== 'complete')
  const unmatchedWithAudio = overlapping.filter((item) => item.file_path && !matchedImports.has(item.id))
  const durationTargets = new Map<string, Recording>()
  for (const recording of [...unmatchedWithAudio, ...missingTranscript]) {
    if (recording.file_path) durationTargets.set(recording.id, recording)
  }
  const allProbed = await mapWithConcurrency([...durationTargets.values()], 8, async (recording) => ({
    recording,
    duration: await durationProvider(recording.file_path!).catch(() => null)
  }))
  const overlappingIds = new Set(overlapping.map((recording) => recording.id))
  const probed = allProbed.filter((item) => overlappingIds.has(item.recording.id))
  const allDurationByRecording = new Map(allProbed.map((item) => [item.recording.id, item.duration]))
  const devicesByDate = new Map<string, ReconciliationDeviceFile[]>()
  for (const file of datedDeviceFiles) {
    const date = localCalendarDate(file.dateCreated)
    if (!date) continue
    const values = devicesByDate.get(date) || []
    values.push(file)
    devicesByDate.set(date, values)
  }

  const edges: Array<{
    recording: Recording
    importedDuration: number
    device: ReconciliationDeviceFile & { dateCreated: string }
    difference: number
    dayOffset: number
  }> = []
  for (const item of probed) {
    const recordingDate = recordingCalendarDate(item.recording)
    if (item.duration === null || !recordingDate) continue
    const allowedOffsets = item.recording.source_date_precision === 'date-only' ? [0, -1, 1] : [0]
    for (const dayOffset of allowedOffsets) {
      const candidateDate = shiftCalendarDate(recordingDate, dayOffset)
      for (const candidate of devicesByDate.get(candidateDate) || []) {
        const deviceDuration = deviceDurationSeconds(candidate)
        if (!candidate.dateCreated || deviceDuration === null) continue
        const difference = Math.abs(item.duration - deviceDuration)
        if (difference <= DURATION_MATCH_TOLERANCE_SECONDS) {
          edges.push({
            recording: item.recording,
            importedDuration: item.duration,
            device: candidate as ReconciliationDeviceFile & { dateCreated: string },
            difference,
            dayOffset
          })
        }
      }
    }
  }
  edges.sort((left, right) => Math.abs(left.dayOffset) - Math.abs(right.dayOffset) || left.difference - right.difference)
  for (const edge of edges) {
    if (matchedImports.has(edge.recording.id) || usedDeviceFiles.has(edge.device.filename)) continue
    matchedImports.add(edge.recording.id)
    usedDeviceFiles.add(edge.device.filename)
    matches.push({
      importedRecordingId: edge.recording.id,
      importedFilename: edge.recording.filename,
      deviceFilename: edge.device.filename,
      deviceRecordedAt: edge.device.dateCreated,
      method: edge.dayOffset === 0 ? 'date-duration' : 'adjacent-date-duration',
      confidence: edge.dayOffset === 0
        ? Math.max(0.9, 0.99 - edge.difference / 100)
        : Math.max(0.85, 0.94 - edge.difference / 100),
      durationDifferenceSeconds: edge.difference
    })
  }

  const durationByRecording = new Map(probed.map((item) => [item.recording.id, item.duration]))
  const unresolved = overlapping.filter((recording) => !matchedImports.has(recording.id)).map((recording) => {
    const date = recordingCalendarDate(recording) || recording.date_recorded
    const importedDuration = durationByRecording.get(recording.id) ?? null
    const nearestCandidates = (devicesByDate.get(date) || [])
      .filter((candidate) => !usedDeviceFiles.has(candidate.filename) && candidate.dateCreated)
      .map((candidate) => {
        const duration = deviceDurationSeconds(candidate)
        return {
          deviceFilename: candidate.filename,
          deviceRecordedAt: candidate.dateCreated!,
          durationDifferenceSeconds: importedDuration !== null && duration !== null
            ? Math.abs(importedDuration - duration)
            : null
        }
      })
      .sort((left, right) =>
        (left.durationDifferenceSeconds ?? Number.POSITIVE_INFINITY) -
        (right.durationDifferenceSeconds ?? Number.POSITIVE_INFINITY))
      .slice(0, 3)
    return {
      importedRecordingId: recording.id,
      importedFilename: recording.filename,
      recordedDate: date,
      durationSeconds: importedDuration,
      nearestCandidates
    }
  })

  const exactTimestampMatches = matches.filter((match) => match.method === 'exact-timestamp').length
  const dateDurationMatches = matches.filter((match) => match.method === 'date-duration').length
  const adjacentDateDurationMatches = matches.filter((match) => match.method === 'adjacent-date-duration').length
  const missingTranscriptUsableAudio = missingTranscript.filter((recording) => {
    const duration = allDurationByRecording.get(recording.id)
    return typeof duration === 'number' && duration >= 5
  }).length
  return {
    generatedAt,
    deviceInventoryStart: inventoryStart,
    deviceInventoryEnd: inventoryEnd,
    counts: {
      deviceRecordings: deviceFiles.length,
      importedOtter: imported.length,
      importedMissingTranscript: missingTranscript.length,
      importedMissingTranscriptUsableAudio: missingTranscriptUsableAudio,
      importedMissingTranscriptUnusableAudio: missingTranscript.length - missingTranscriptUsableAudio,
      preDeviceOtterOnly: preDevice.length,
      overlappingOtter: overlapping.length,
      exactTimestampMatches,
      dateDurationMatches,
      adjacentDateDurationMatches,
      provisionalMatches: matches.length,
      unresolvedOverlapping: unresolved.length,
      deviceWithoutOtterMatch: Math.max(0, deviceFiles.length - usedDeviceFiles.size)
    },
    matches,
    unresolved
  }
}
