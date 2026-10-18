/** @vitest-environment node */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  analyzeTranscriptWithOpenAI,
  mergeTranscriptChunks,
  OPENAI_AUDIO_FILE_LIMIT_BYTES,
  transcribeAudioWithOpenAI,
  transcribeAudioWithOpenAIDiarization
} from '../openai-transcription'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenAI transcription provider', () => {
  it('merges overlapping chunk transcripts into one transcript', () => {
    expect(mergeTranscriptChunks([
      'We agreed to launch the pilot next Monday morning.',
      'the pilot next Monday morning. Maria will prepare the checklist.'
    ])).toBe('We agreed to launch the pilot next Monday morning. Maria will prepare the checklist.')
  })

  it('uploads a supported audio file and returns transcript text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: '  Test transcript.  ' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const text = await transcribeAudioWithOpenAI({
      apiKey: 'sk-test-key',
      audio: Buffer.from('audio'),
      filePath: 'C:\\recordings\\meeting.hda',
      mimeType: 'audio/mp3',
      model: 'gpt-transcribe'
    })

    expect(text).toBe('Test transcript.')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/transcriptions',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer sk-test-key' }
      })
    )
  })

  it('aborts an in-flight transcription request when its signal is cancelled', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted', 'AbortError'))
      }, { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)

    const request = transcribeAudioWithOpenAI({
      apiKey: 'sk-test-key',
      audio: Buffer.from('audio'),
      filePath: 'meeting.mp3',
      mimeType: 'audio/mp3',
      model: 'gpt-transcribe',
      signal: controller.signal
    })
    controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal)
  })

  it('corrects legacy WAV filenames when the bytes are actually MP3', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: 'Legacy file transcript.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await transcribeAudioWithOpenAI({
      apiKey: 'sk-test-key',
      audio: Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00]),
      filePath: 'legacy-recording.wav',
      mimeType: 'audio/wav',
      model: 'gpt-transcribe'
    })

    const request = fetchMock.mock.calls[0][1] as RequestInit
    const form = request.body as FormData
    const file = form.get('file') as File
    expect(file.name).toBe('legacy-recording.mp3')
    expect(file.type).toBe('audio/mpeg')
  })

  it('rejects files larger than the API limit without making a request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(transcribeAudioWithOpenAI({
      apiKey: 'sk-test-key',
      audio: Buffer.alloc(OPENAI_AUDIO_FILE_LIMIT_BYTES + 1),
      filePath: 'large.mp3',
      mimeType: 'audio/mp3',
      model: 'gpt-transcribe'
    })).rejects.toThrow('files up to 25 MB')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requests diarized segments with a bounded known-speaker reference', async () => {
    const response = {
      text: 'Joel K: Hello.',
      duration: 2.5,
      segments: [{
        type: 'transcript.text.segment', id: 'seg-1', start: 0, end: 2.5, text: 'Hello.', speaker: 'Joel K'
      }]
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(transcribeAudioWithOpenAIDiarization({
      apiKey: 'sk-test-key',
      audio: Buffer.from('audio'),
      filePath: 'meeting.mp3',
      mimeType: 'audio/mp3',
      knownSpeakers: [{ name: 'Joel K', dataUrl: 'data:audio/wav;base64,AAAA' }]
    })).resolves.toEqual(response)

    const request = fetchMock.mock.calls[0][1] as RequestInit
    const form = request.body as FormData
    expect(form.get('model')).toBe('gpt-4o-transcribe-diarize')
    expect(form.get('response_format')).toBe('diarized_json')
    expect(form.get('chunking_strategy')).toBe('auto')
    expect(form.getAll('known_speaker_names[]')).toEqual(['Joel K'])
    expect(form.getAll('known_speaker_references[]')).toEqual(['data:audio/wav;base64,AAAA'])
  })

  it('parses structured transcript analysis from the Responses API', async () => {
    const analysis = {
      summary: 'Summary',
      action_items: ['Follow up'],
      topics: ['Testing'],
      key_points: ['Provider works'],
      title_suggestion: 'Provider Test',
      question_suggestions: ['What comes next?'],
      language: 'en',
      selected_meeting_id: null,
      meeting_confidence: 0,
      selection_reason: ''
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        output: [{ content: [{ type: 'output_text', text: JSON.stringify(analysis) }] }]
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    ))

    await expect(analyzeTranscriptWithOpenAI({
      apiKey: 'sk-test-key',
      model: 'gpt-6-luna',
      prompt: 'Analyze this transcript'
    })).resolves.toEqual(analysis)
  })
})
