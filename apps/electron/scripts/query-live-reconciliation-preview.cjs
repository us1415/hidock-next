const http = require('node:http')
const { execFileSync } = require('node:child_process')
const { readFileSync, statSync } = require('node:fs')

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(error)
        }
      })
    }).on('error', reject)
  })
}

async function main() {
  const missingOnly = process.argv.includes('--missing-only')
  const conflictsOnly = process.argv.includes('--canonical-conflicts-only')
  const canonicalPlanOnly = process.argv.includes('--canonical-plan')
  const full = process.argv.includes('--full') || missingOnly || conflictsOnly
  const pages = await getJson('http://127.0.0.1:9222/json/list')
  const page = pages.find((candidate) => candidate.type === 'page' && candidate.url.includes('localhost:5173'))
  if (!page) throw new Error('HiDock Electron renderer was not found on the debug port.')

  const socket = new WebSocket(page.webSocketDebuggerUrl)
  const response = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for the live preview.')), 60_000)
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: canonicalPlanOnly
            ? 'window.electronAPI.imports.previewOtterCanonicalMerge()'
            : full
            ? `Promise.all([
                window.electronAPI.imports.previewOtterReconciliation(),
                window.electronAPI.recordings.getAll(),
                window.electronAPI.knowledge.getAll({ limit: 5000 })
              ]).then(([previewResult, recordings, knowledgeCaptures]) => ({
                previewResult,
                recordings,
                knowledgeCaptures
              }))`
            : 'window.electronAPI.imports.previewOtterReconciliation()',
          awaitPromise: true,
          returnByValue: true
        }
      }))
    })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== 1) return
      clearTimeout(timeout)
      resolve(message)
    })
    socket.addEventListener('error', reject)
  })
  socket.close()

  if (response.error) throw new Error(JSON.stringify(response.error))
  const value = response.result?.result?.value
  if (canonicalPlanOnly) {
    if (!value?.success) throw new Error(value?.error || 'The canonical merge dry run failed.')
    console.log(JSON.stringify({
      generatedAt: value.plan.generatedAt,
      previewGeneratedAt: value.plan.previewGeneratedAt,
      policy: value.plan.policy,
      fingerprint: value.plan.fingerprint,
      ready: value.plan.ready,
      counts: value.plan.counts,
      consolidations: value.plan.actions.filter((action) => action.kind === 'consolidate-existing'),
      blockers: value.plan.blockers
    }, null, 2))
    return
  }
  const result = full ? value?.previewResult : value
  if (!result?.success) throw new Error(result?.error || 'The reconciliation preview failed.')
  const recordingsById = new Map((full ? value.recordings : []).map((recording) => [recording.id, recording]))
  const capturesByRecordingId = new Map(
    (full ? value.knowledgeCaptures : []).map((capture) => [capture.sourceRecordingId, capture])
  )
  const unresolved = result.preview.unresolved.map((item) => {
    const recording = recordingsById.get(item.importedRecordingId)
    const nearestDifference = item.nearestCandidates[0]?.durationDifferenceSeconds ?? null
    let classification = 'needs-audio-evidence'
    if (item.nearestCandidates.length === 0) classification = 'no-unused-device-recording-on-date'
    else if (nearestDifference !== null && nearestDifference > 120) classification = 'duration-conflict-likely-unrelated'
    else if (nearestDifference !== null && nearestDifference <= 30) classification = 'close-duration-fingerprint-candidate'
    return {
      ...item,
      sourceDatePrecision: recording?.source_date_precision ?? null,
      transcriptionStatus: recording?.transcription_status ?? null,
      classification
    }
  })
  const classificationCounts = unresolved.reduce((counts, item) => {
    counts[item.classification] = (counts[item.classification] || 0) + 1
    return counts
  }, {})
  const matchesByImportId = new Map(result.preview.matches.map((match) => [match.importedRecordingId, match]))
  const recordingsByFilename = new Map(
    [...recordingsById.values()].map((recording) => [recording.filename, recording])
  )
  const baseName = (filename) => filename.replace(/\.[^.]+$/, '').toLowerCase()
  const recordingsByBase = new Map(
    [...recordingsById.values()].map((recording) => [baseName(recording.filename), recording])
  )
  const canonicalTargetConflicts = result.preview.matches.flatMap((match) => {
    const target = recordingsByFilename.get(match.deviceFilename) || recordingsByBase.get(baseName(match.deviceFilename))
    if (!target || target.id === match.importedRecordingId) return []
    const imported = recordingsById.get(match.importedRecordingId)
    return [{
      importedRecordingId: match.importedRecordingId,
      importedFilename: match.importedFilename,
      importedTranscriptionStatus: imported?.transcription_status ?? null,
      deviceFilename: match.deviceFilename,
      targetRecordingId: target.id,
      targetTranscriptionStatus: target.transcription_status,
      importedCaptureId: capturesByRecordingId.get(match.importedRecordingId)?.id ?? null,
      targetCaptureId: capturesByRecordingId.get(target.id)?.id ?? null,
      targetLocalPath: target.file_path,
      targetMeetingId: target.meeting_id ?? null
    }]
  })
  const missingTranscripts = [...recordingsById.values()]
    .filter((recording) => recording.is_imported === 1 && recording.source === 'import')
    .filter((recording) => recording.transcription_status !== 'complete')
    .map((recording) => ({
      id: recording.id,
      filename: recording.filename,
      recordedAt: recording.date_recorded,
      sourceDatePrecision: recording.source_date_precision,
      fileBytes: (() => {
        try {
          return statSync(recording.file_path).size
        } catch {
          return null
        }
      })(),
      headerHex: (() => {
        try {
          return readFileSync(recording.file_path).subarray(0, 16).toString('hex')
        } catch {
          return null
        }
      })(),
      durationSeconds: (() => {
        try {
          return Number.parseFloat(execFileSync('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            recording.file_path
          ], { encoding: 'utf8', windowsHide: true }).trim())
        } catch {
          return null
        }
      })(),
      proposedMatch: matchesByImportId.get(recording.id) || null
    }))
  if (conflictsOnly) {
    console.log(JSON.stringify({ count: canonicalTargetConflicts.length, items: canonicalTargetConflicts }, null, 2))
    return
  }
  if (missingOnly) {
    const totalSeconds = missingTranscripts.reduce((sum, item) => sum + (item.durationSeconds || 0), 0)
    console.log(JSON.stringify({
      count: missingTranscripts.length,
      totalMinutes: totalSeconds / 60,
      estimatedGptTranscribeCostUsd: totalSeconds / 60 * 0.0045,
      items: missingTranscripts
    }, null, 2))
    return
  }
  console.log(JSON.stringify({
    generatedAt: result.preview.generatedAt,
    deviceInventoryStart: result.preview.deviceInventoryStart,
    deviceInventoryEnd: result.preview.deviceInventoryEnd,
    counts: result.preview.counts,
    adjacentMatches: full
      ? result.preview.matches.filter((match) => match.method === 'adjacent-date-duration')
      : undefined,
    classificationCounts: full ? classificationCounts : undefined,
    canonicalTargetConflicts: full ? canonicalTargetConflicts : undefined,
    missingTranscripts: full ? missingTranscripts : undefined,
    unresolved: full ? unresolved : unresolved.slice(0, 5)
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
