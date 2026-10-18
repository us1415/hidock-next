/**
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  loadURL: vi.fn(),
  printToPDF: vi.fn(),
  isDestroyed: vi.fn(),
  destroy: vi.fn(),
  constructorOptions: [] as unknown[]
}))

vi.mock('electron', () => ({
  BrowserWindow: class MockBrowserWindow {
    webContents = { printToPDF: electronMocks.printToPDF }

    constructor(options: unknown) {
      electronMocks.constructorOptions.push(options)
    }

    loadURL = electronMocks.loadURL
    isDestroyed = electronMocks.isDestroyed
    destroy = electronMocks.destroy
  }
}))

import { buildTranscriptPdfHtml, createTranscriptPdfBuffer } from '../transcript-pdf'

const recording = {
  id: 'recording-id',
  filename: '2026Oct16-102913-Rec21.mp3',
  original_filename: '2026Oct16-102913-Rec21.hda',
  date_recorded: '2026-10-16T15:29:13.000Z'
}

const transcript = {
  id: 'transcript-id',
  recording_id: 'recording-id',
  full_text: 'First line.\nSecond <line> & more.',
  summary: 'Summary with <unsafe> & quoted "content".',
  title_suggestion: 'Vendor <Direct> & Intake',
  transcription_provider: 'openai',
  transcription_model: 'gpt-transcribe',
  word_count: 7
}

describe('transcript PDF export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    electronMocks.constructorOptions.length = 0
    electronMocks.loadURL.mockResolvedValue(undefined)
    electronMocks.printToPDF.mockResolvedValue(Buffer.from('%PDF-rendered'))
    electronMocks.isDestroyed.mockReturnValue(false)
  })

  it('builds printable HTML with source metadata and escaped user content', () => {
    const html = buildTranscriptPdfHtml(recording as any, transcript as any)

    expect(html).toContain('Vendor &lt;Direct&gt; &amp; Intake')
    expect(html).toContain('Summary with &lt;unsafe&gt; &amp; quoted &quot;content&quot;.')
    expect(html).toContain('Second &lt;line&gt; &amp; more.')
    expect(html).toContain('<div class="transcript"><p>First line.\nSecond &lt;line&gt; &amp; more.</p></div>')
    expect(html).not.toContain('<unsafe>')
    expect(html).toContain('2026-10-16T15:29:13.000Z')
    expect(html).toContain('2026Oct16-102913-Rec21.hda')
    expect(html).toContain('openai / gpt-transcribe')
    expect(html).toContain('The recorded date above comes from the source recording')
  })

  it('prints in a secure hidden window and always destroys it', async () => {
    const result = await createTranscriptPdfBuffer(recording as any, transcript as any)

    expect(result).toEqual(Buffer.from('%PDF-rendered'))
    expect(electronMocks.constructorOptions).toEqual([
      expect.objectContaining({
        show: false,
        webPreferences: expect.objectContaining({
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        })
      })
    ])
    expect(electronMocks.loadURL).toHaveBeenCalledWith(expect.stringMatching(/^data:text\/html;charset=utf-8,/))
    expect(electronMocks.printToPDF).toHaveBeenCalledWith(expect.objectContaining({
      printBackground: true,
      pageSize: 'A4',
      displayHeaderFooter: true
    }))
    expect(electronMocks.destroy).toHaveBeenCalledOnce()
  })

  it('destroys the hidden window when PDF rendering fails', async () => {
    electronMocks.printToPDF.mockRejectedValue(new Error('PDF rendering failed'))

    await expect(createTranscriptPdfBuffer(recording as any, transcript as any)).rejects.toThrow('PDF rendering failed')
    expect(electronMocks.destroy).toHaveBeenCalledOnce()
  })
})
