/**
 * Resolve a recording's source timestamp without manufacturing one from the
 * time the app happened to observe, download, or import the file.
 */
export function parseRecordingDateFromFilename(filename: string): Date | null {
  const monthNames: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
  }

  // HiDock filenames use local device time rather than UTC.
  const monthNameMatch = filename.match(
    /(\d{4})(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(\d{1,2})-(\d{2})(\d{2})(\d{2})/
  )
  if (monthNameMatch) {
    const [, year, monthName, day, hour, minute, second] = monthNameMatch
    const parsed = new Date(
      Number(year),
      monthNames[monthName],
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    )
    if (!Number.isNaN(parsed.getTime())) return parsed
  }

  const numericMatch = filename.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})[-_](\d{2})(\d{2})(\d{2})?/)
  if (numericMatch) {
    const [, year, month, day, hour, minute, second = '00'] = numericMatch
    const parsed = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    )
    if (!Number.isNaN(parsed.getTime())) return parsed
  }

  return null
}

export function resolveSourceRecordingDate(
  filename: string,
  deviceDate?: Date | string | null
): Date | null {
  const filenameDate = parseRecordingDateFromFilename(filename)
  if (filenameDate) return filenameDate

  if (deviceDate !== null && deviceDate !== undefined) {
    const parsed = deviceDate instanceof Date ? deviceDate : new Date(deviceDate)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }

  return null
}

export function sourceRecordingDateIso(
  filename: string,
  deviceDate?: Date | string | null
): string | null {
  return resolveSourceRecordingDate(filename, deviceDate)?.toISOString() ?? null
}
