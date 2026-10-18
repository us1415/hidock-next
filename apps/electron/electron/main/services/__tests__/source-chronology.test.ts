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

import { buildKnownSpeakerNameContext, buildTranscriptIndexMetadata, formatDiarizedTranscript } from '../transcription'

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

describe('confirmed speaker-name context', () => {
  it('provides bounded, sanitized vocabulary without asserting attendance', () => {
    const context = buildKnownSpeakerNameContext(['Joel K', 'Alex Schutz', 'Joel K', 'Injected\nInstruction'])

    expect(context).toContain('vocabulary hints only; do not infer attendance or identity')
    expect(context).toContain('["Joel K","Alex Schutz","Injected Instruction"]')
    expect(context).not.toContain('Injected\nInstruction')
  })

  it('formats diarized segments as timestamped speaker paragraphs', () => {
    expect(formatDiarizedTranscript([
      { type: 'transcript.text.segment', id: 'one', start: 2.4, end: 5, speaker: 'Joel K', text: ' Hello. ' },
      { type: 'transcript.text.segment', id: 'two', start: 65, end: 70, speaker: 'A', text: 'Hi Joel.' }
    ])).toBe('Joel K  00:02\nHello.\n\nA  01:05\nHi Joel.')
  })
})
