const fs = require('fs')
const { execFile } = require('child_process')
const initSqlJs = require('sql.js')

const databasePath = process.argv[2] || 'C:/Users/us141/HiDock/data/hidock.db'
const cutoff = process.argv[3] || '2025-11-01'
const timeZone = process.argv[4] || 'America/Chicago'
const concurrency = 8

function rows(database, sql, params = []) {
  const result = database.exec(sql, params)[0]
  if (!result) return []
  return result.values.map((values) => Object.fromEntries(result.columns.map((column, index) => [column, values[index]])))
}

function localDay(value) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(value))
  const get = (type) => parts.find((part) => part.type === type)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], { windowsHide: true }, (error, stdout) => {
      if (error) reject(error)
      else resolve(Number.parseFloat(stdout.trim()))
    })
  })
}

async function mapLimit(items, limit, mapper) {
  const result = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const index = next++
      result[index] = await mapper(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return result
}

async function main() {
  const SQL = await initSqlJs()
  const database = new SQL.Database(fs.readFileSync(databasePath))
  const imports = rows(database, `
    SELECT id, filename, file_path, file_size, date_recorded, source_date_precision
    FROM recordings
    WHERE is_imported = 1
    ORDER BY date_recorded, filename
  `)
  const device = rows(database, 'SELECT filename, size, duration, dateCreated FROM device_file_cache')
  const cutoffTime = new Date(`${cutoff}T00:00:00Z`).getTime()
  const overlappingImports = imports.filter((item) => new Date(item.date_recorded).getTime() >= cutoffTime)
  const exactImports = overlappingImports.filter((item) => item.source_date_precision === 'exact')
  const dateOnlyImports = overlappingImports.filter((item) => item.source_date_precision === 'date-only')

  const deviceByTime = new Map(device.map((item) => [new Date(item.dateCreated).getTime(), item]))
  const exactMatches = exactImports
    .map((item) => ({ item, device: deviceByTime.get(new Date(item.date_recorded).getTime()) }))
    .filter((match) => match.device)

  const probed = await mapLimit(dateOnlyImports, concurrency, async (item) => ({
    ...item,
    duration: await probeDuration(item.file_path)
  }))
  const devicesByDay = new Map()
  for (const item of device) {
    const day = localDay(item.dateCreated)
    const values = devicesByDay.get(day) || []
    values.push({ ...item, correctedDuration: item.size / 12000 })
    devicesByDay.set(day, values)
  }

  const edges = []
  for (const item of probed) {
    for (const candidate of devicesByDay.get(item.date_recorded) || []) {
      const difference = Math.abs(item.duration - candidate.correctedDuration)
      if (difference <= 5) edges.push({ item, candidate, difference })
    }
  }
  edges.sort((left, right) => left.difference - right.difference)
  const usedImports = new Set()
  const usedDevices = new Set(exactMatches.map((match) => match.device.filename))
  const durationMatches = []
  for (const edge of edges) {
    if (usedImports.has(edge.item.id) || usedDevices.has(edge.candidate.filename)) continue
    usedImports.add(edge.item.id)
    usedDevices.add(edge.candidate.filename)
    durationMatches.push(edge)
  }

  const unmatchedDateOnly = probed.filter((item) => !usedImports.has(item.id))
  const ambiguous = unmatchedDateOnly.map((item) => {
    const candidates = (devicesByDay.get(item.date_recorded) || [])
      .map((candidate) => ({
        filename: candidate.filename,
        durationDifference: Math.abs(item.duration - candidate.correctedDuration)
      }))
      .sort((left, right) => left.durationDifference - right.durationDifference)
      .slice(0, 3)
    return { title: item.filename, date: item.date_recorded, duration: item.duration, candidates }
  })

  console.log(JSON.stringify({
    cutoff,
    deviceInventory: device.length,
    imported: imports.length,
    overlappingImports: overlappingImports.length,
    preCutoffOtterOnly: imports.length - overlappingImports.length,
    exactTimestampMatches: exactMatches.length,
    dateOnlyImports: dateOnlyImports.length,
    dateAndDurationMatchesWithinFiveSeconds: durationMatches.length,
    totalProvisionalMatches: exactMatches.length + durationMatches.length,
    unmatchedOverlappingImports: overlappingImports.length - exactMatches.length - durationMatches.length,
    unmatchedDateOnlySample: ambiguous.slice(0, 20)
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
