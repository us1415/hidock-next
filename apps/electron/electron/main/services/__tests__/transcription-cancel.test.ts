/** @vitest-environment node */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockUpdateQueueItem = vi.fn()
const mockUpdateRecordingStatus = vi.fn()
const mockRemoveFromQueue = vi.fn()
const mockFinishHistory = vi.fn()
const mockTranscribe = vi.fn((options: { signal?: AbortSignal }) => new Promise<string>((_resolve, reject) => {
  options.signal?.addEventListener('abort', () => {
    reject(new DOMException('The operation was aborted', 'AbortError'))
  }, { once: true })
}))

vi.mock('../database', () => ({
  getRecordingById: vi.fn(() => ({
    id: 'rec-1',
    filename: 'meeting.mp3',
    file_path: 'C:\\recordings\\meeting.mp3',
    date_recorded: '2026-10-16T15:29:13.000Z',
    duration_seconds: 1800,
    meeting_id: null,
    correlation_method: null
  })),
  updateRecordingTranscriptionStatus: (...args: unknown[]) => mockUpdateRecordingStatus(...args),
  insertTranscript: vi.fn(),
  getQueueItems: vi.fn((status?: string) => status === 'pending'
    ? [{
        id: 'queue-1',
        recording_id: 'rec-1',
        filename: 'meeting.mp3',
        status: 'pending',
        attempts: 0,
        retry_count: 0,
        progress: 0,
        created_at: '2026-10-18T10:00:00.000Z'
      }]
    : []),
  updateQueueItem: (...args: unknown[]) => mockUpdateQueueItem(...args),
  updateQueueProgress: vi.fn(),
  getMeetingById: vi.fn(),
  findCandidateMeetingsForRecording: vi.fn(() => []),
  addRecordingMeetingCandidate: vi.fn(),
  linkRecordingToMeeting: vi.fn(),
  updateKnowledgeCaptureTitle: vi.fn(),
  removeFromQueueByRecordingId: (...args: unknown[]) => mockRemoveFromQueue(...args),
  cancelPendingTranscriptions: vi.fn(() => 1),
  acquireTranscriptionLock: vi.fn(() => true),
  releaseTranscriptionLock: vi.fn(() => true),
  clearStaleTranscriptionLock: vi.fn(),
  startTranscriptionHistory: vi.fn(() => 'history-1'),
  finishTranscriptionHistory: (...args: unknown[]) => mockFinishHistory(...args),
  run: vi.fn(),
  queryOne: vi.fn()
}))

vi.mock('../config', () => ({
  getConfig: vi.fn(() => ({
    transcription: {
      provider: 'openai',
      openaiApiKey: 'sk-test',
      openaiTranscriptionModel: 'gpt-transcribe',
      openaiAnalysisModel: 'gpt-6-luna',
      geminiApiKey: '',
      geminiModel: 'gemini-test'
    }
  }))
}))

vi.mock('../openai-transcription', () => ({
  transcribeAudioFileWithOpenAI: (...args: unknown[]) => mockTranscribe(...args as [{ signal?: AbortSignal }]),
  analyzeTranscriptWithOpenAI: vi.fn()
}))

vi.mock('../vector-store', () => ({ getVectorStore: vi.fn() }))
vi.mock('../activity-log', () => ({ emitActivityLog: vi.fn() }))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  readFile: vi.fn()
}))

vi.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: vi.fn() }))

describe('active transcription cancellation', () => {
  beforeEach(() => vi.clearAllMocks())

  afterEach(async () => {
    const { stopTranscriptionProcessor } = await import('../transcription')
    stopTranscriptionProcessor()
  })

  it('aborts the provider request and records cancellation without a retryable failure', async () => {
    const {
      cancelTranscription,
      startTranscriptionProcessor
    } = await import('../transcription')

    startTranscriptionProcessor()
    await vi.waitFor(() => expect(mockTranscribe).toHaveBeenCalledOnce())

    cancelTranscription('rec-1')

    await vi.waitFor(() => {
      expect(mockFinishHistory).toHaveBeenCalledWith(
        'history-1',
        'cancelled',
        expect.any(Number),
        'Cancelled by user'
      )
    })

    expect(mockTranscribe.mock.calls[0]![0].signal?.aborted).toBe(true)
    expect(mockRemoveFromQueue).toHaveBeenCalledWith('rec-1')
    expect(mockUpdateRecordingStatus).toHaveBeenCalledWith('rec-1', 'none')
    expect(mockUpdateQueueItem).not.toHaveBeenCalledWith(
      'queue-1',
      'failed',
      expect.anything()
    )
  })
})
