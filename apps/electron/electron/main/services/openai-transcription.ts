import { execFile } from 'child_process'
import { mkdtemp, readFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, extname, join } from 'path'
import { promisify } from 'util'

export const OPENAI_AUDIO_FILE_LIMIT_BYTES = 25 * 1024 * 1024
const OPENAI_CHUNK_DURATION_SECONDS = 20 * 60
const OPENAI_CHUNK_OVERLAP_SECONDS = 2
const OPENAI_CHUNK_BITRATE = '48k'
const execFileAsync = promisify(execFile)

interface OpenAIErrorResponse {
  error?: {
    message?: string
  }
}

export interface OpenAITranscriptAnalysis {
  summary: string
  action_items: string[]
  topics: string[]
  key_points: string[]
  title_suggestion: string
  question_suggestions: string[]
  language: string
  selected_meeting_id: string | null
  meeting_confidence: number
  selection_reason: string
}

async function getOpenAIError(response: Response): Promise<string> {
  try {
    const body = await response.json() as OpenAIErrorResponse
    return body.error?.message || `${response.status} ${response.statusText}`
  } catch {
    return `${response.status} ${response.statusText}`
  }
}

function detectAudioUpload(audio: Buffer, filePath: string, fallbackMimeType: string): {
  filename: string
  mimeType: string
} {
  const filename = basename(filePath)
  const extension = extname(filename).toLowerCase()
  const base = extension ? filename.slice(0, -extension.length) : filename

  const isMp3 = audio.subarray(0, 3).toString('ascii') === 'ID3' ||
    (audio.length >= 2 && audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0)
  if (isMp3 || extension === '.hda') {
    return { filename: `${base}.mp3`, mimeType: 'audio/mpeg' }
  }

  const isWav = audio.subarray(0, 4).toString('ascii') === 'RIFF' &&
    audio.subarray(8, 12).toString('ascii') === 'WAVE'
  if (isWav) return { filename: `${base}.wav`, mimeType: 'audio/wav' }

  if (audio.subarray(0, 4).toString('ascii') === 'OggS') {
    return { filename: `${base}.ogg`, mimeType: 'audio/ogg' }
  }

  if (audio.subarray(4, 8).toString('ascii') === 'ftyp') {
    return { filename: `${base}.m4a`, mimeType: 'audio/mp4' }
  }

  return { filename, mimeType: fallbackMimeType }
}

function ffmpegExecutable(): string {
  return process.env.FFMPEG_PATH?.trim() || 'ffmpeg'
}

function ffprobeExecutable(): string {
  const ffmpegPath = ffmpegExecutable()
  const ffmpegName = basename(ffmpegPath).toLowerCase()
  if (ffmpegName === 'ffmpeg.exe') return join(dirname(ffmpegPath), 'ffprobe.exe')
  if (ffmpegName === 'ffmpeg') return join(dirname(ffmpegPath), 'ffprobe')
  return 'ffprobe'
}

async function getAudioDurationSeconds(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(ffprobeExecutable(), [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ])
  const duration = Number.parseFloat(stdout.trim())
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Could not determine the recording duration for transcription chunking')
  }
  return duration
}

async function createAudioChunk(
  sourcePath: string,
  outputPath: string,
  startSeconds: number
): Promise<void> {
  await execFileAsync(ffmpegExecutable(), [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', startSeconds.toFixed(3),
    '-i', sourcePath,
    '-t', OPENAI_CHUNK_DURATION_SECONDS.toString(),
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-b:a', OPENAI_CHUNK_BITRATE,
    '-y',
    outputPath
  ])
}

function comparableWord(word: string): string {
  return word.toLocaleLowerCase().replace(/[^\p{L}\p{N}']/gu, '')
}

/** Merge overlapping chunk transcripts without exposing chunk boundaries to the user. */
export function mergeTranscriptChunks(chunks: string[]): string {
  let mergedWords: string[] = []

  for (const chunk of chunks) {
    const incomingWords = chunk.trim().split(/\s+/).filter(Boolean)
    if (incomingWords.length === 0) continue
    if (mergedWords.length === 0) {
      mergedWords = incomingWords
      continue
    }

    const maxOverlap = Math.min(80, mergedWords.length, incomingWords.length)
    let overlap = 0
    for (let candidate = maxOverlap; candidate >= 3; candidate -= 1) {
      const existingTail = mergedWords.slice(-candidate).map(comparableWord)
      const incomingHead = incomingWords.slice(0, candidate).map(comparableWord)
      if (existingTail.every((word, index) => word !== '' && word === incomingHead[index])) {
        overlap = candidate
        break
      }
    }
    mergedWords.push(...incomingWords.slice(overlap))
  }

  return mergedWords.join(' ').trim()
}

export async function transcribeAudioWithOpenAI(options: {
  apiKey: string
  audio: Buffer
  filePath: string
  mimeType: string
  model: string
  prompt?: string
  signal?: AbortSignal
}): Promise<string> {
  if (options.audio.byteLength > OPENAI_AUDIO_FILE_LIMIT_BYTES) {
    const sizeMb = (options.audio.byteLength / (1024 * 1024)).toFixed(1)
    throw new Error(
      `OpenAI transcription accepts files up to 25 MB; this recording is ${sizeMb} MB. ` +
      'Audio chunking is not implemented yet.'
    )
  }

  const upload = detectAudioUpload(options.audio, options.filePath, options.mimeType)
  const form = new FormData()
  form.append('model', options.model)
  form.append(
    'file',
    new Blob([new Uint8Array(options.audio)], { type: upload.mimeType }),
    upload.filename
  )
  if (options.prompt?.trim()) {
    form.append('prompt', options.prompt.trim())
  }

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`
    },
    body: form,
    signal: options.signal
  })

  if (!response.ok) {
    throw new Error(`OpenAI transcription failed: ${await getOpenAIError(response)}`)
  }

  const result = await response.json() as { text?: string }
  if (!result.text?.trim()) {
    throw new Error('OpenAI transcription returned no text')
  }
  return result.text.trim()
}

/**
 * Transcribe a complete recording. Large recordings are converted into private
 * temporary MP3 chunks, uploaded sequentially, merged, and then removed.
 */
export async function transcribeAudioFileWithOpenAI(options: {
  apiKey: string
  filePath: string
  mimeType: string
  model: string
  prompt?: string
  onProgress?: (completedChunks: number, totalChunks: number) => void
  signal?: AbortSignal
}): Promise<string> {
  const fileInfo = await stat(options.filePath)
  if (fileInfo.size <= OPENAI_AUDIO_FILE_LIMIT_BYTES) {
    return transcribeAudioWithOpenAI({
      ...options,
      audio: await readFile(options.filePath)
    })
  }

  const duration = await getAudioDurationSeconds(options.filePath)
  const chunkStep = OPENAI_CHUNK_DURATION_SECONDS - OPENAI_CHUNK_OVERLAP_SECONDS
  const chunkStarts: number[] = []
  for (let start = 0; start < duration; start += chunkStep) chunkStarts.push(start)

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'hidock-openai-'))
  const transcripts: string[] = []

  try {
    for (let index = 0; index < chunkStarts.length; index += 1) {
      options.signal?.throwIfAborted()
      const chunkPath = join(temporaryDirectory, `chunk-${String(index).padStart(3, '0')}.mp3`)
      await createAudioChunk(options.filePath, chunkPath, chunkStarts[index])
      const chunk = await readFile(chunkPath)
      if (chunk.byteLength > OPENAI_AUDIO_FILE_LIMIT_BYTES) {
        throw new Error('A generated transcription chunk exceeded OpenAI\'s 25 MB upload limit')
      }

      const previousContext = transcripts.length > 0
        ? `\nPrevious transcript context: ${transcripts.at(-1)!.slice(-1500)}`
        : ''
      transcripts.push(await transcribeAudioWithOpenAI({
        apiKey: options.apiKey,
        audio: chunk,
        filePath: chunkPath,
        mimeType: 'audio/mp3',
        model: options.model,
        prompt: `${options.prompt?.trim() || ''}${previousContext}`.trim(),
        signal: options.signal
      }))
      options.onProgress?.(index + 1, chunkStarts.length)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('FFmpeg is required to transcribe recordings larger than 25 MB')
    }
    throw error
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }

  return mergeTranscriptChunks(transcripts)
}

function extractResponseText(body: unknown): string {
  if (!body || typeof body !== 'object') return ''

  const response = body as {
    output_text?: string
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>
  }
  if (response.output_text) return response.output_text

  return (response.output || [])
    .flatMap((item) => item.content || [])
    .filter((content) => content.type === 'output_text' && typeof content.text === 'string')
    .map((content) => content.text)
    .join('')
}

export async function analyzeTranscriptWithOpenAI(options: {
  apiKey: string
  model: string
  prompt: string
  signal?: AbortSignal
}): Promise<OpenAITranscriptAnalysis> {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: options.model,
      instructions: 'Analyze the meeting transcript. Return only data that follows the supplied JSON schema.',
      input: options.prompt,
      text: {
        format: {
          type: 'json_schema',
          name: 'meeting_analysis',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              action_items: { type: 'array', items: { type: 'string' } },
              topics: { type: 'array', items: { type: 'string' } },
              key_points: { type: 'array', items: { type: 'string' } },
              title_suggestion: { type: 'string' },
              question_suggestions: { type: 'array', items: { type: 'string' } },
              language: { type: 'string' },
              selected_meeting_id: { type: ['string', 'null'] },
              meeting_confidence: { type: 'number', minimum: 0, maximum: 1 },
              selection_reason: { type: 'string' }
            },
            required: [
              'summary',
              'action_items',
              'topics',
              'key_points',
              'title_suggestion',
              'question_suggestions',
              'language',
              'selected_meeting_id',
              'meeting_confidence',
              'selection_reason'
            ],
            additionalProperties: false
          }
        }
      }
    }),
    signal: options.signal
  })

  if (!response.ok) {
    throw new Error(`OpenAI transcript analysis failed: ${await getOpenAIError(response)}`)
  }

  const responseBody = await response.json()
  const responseText = extractResponseText(responseBody)
  if (!responseText) {
    throw new Error('OpenAI transcript analysis returned no text')
  }

  try {
    return JSON.parse(responseText) as OpenAITranscriptAnalysis
  } catch {
    throw new Error('OpenAI transcript analysis returned invalid JSON')
  }
}
