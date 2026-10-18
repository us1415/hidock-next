/**
 * @vitest-environment node
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

vi.mock('../database', () => ({
  clearStaleTranscriptionLock: vi.fn()
}))

vi.mock('../vector-store', () => ({ getVectorStore: vi.fn() }))
vi.mock('../config', () => ({ getConfig: vi.fn() }))
vi.mock('../openai-transcription', () => ({
  analyzeTranscriptWithOpenAI: vi.fn(),
  transcribeAudioFileWithOpenAI: vi.fn()
}))

import { buildTranscriptIndexMetadata } from '../transcription'

describe('source chronology', () => {
  it('indexes transcript chunks with the recording date, never ingestion time', () => {
    const metadata = buildTranscriptIndexMetadata({
      id: 'recording-1',
      date_recorded: '2026-10-16T15:29:13.000Z'
    })

    expect(metadata).toEqual({
      meetingId: undefined,
      recordingId: 'recording-1',
      timestamp: '2026-10-16T15:29:13.000Z',
      subject: undefined
    })
    expect(metadata.timestamp).not.toBe('2026-10-18T20:00:00.000Z')
  })
})
