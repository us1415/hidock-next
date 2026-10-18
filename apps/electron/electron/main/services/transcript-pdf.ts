import { BrowserWindow } from 'electron'
import { basename, extname } from 'path'
import type { Recording, Transcript } from './database'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatRecordedDate(value: string): { display: string; iso: string } {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return { display: value, iso: value }

  return {
    display: new Intl.DateTimeFormat('en-US', {
      dateStyle: 'long',
      timeStyle: 'short'
    }).format(date),
    iso: date.toISOString()
  }
}

function formatTranscriptParagraphs(value: string): string {
  return value
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join('')
}

export function buildTranscriptPdfHtml(recording: Recording, transcript: Transcript): string {
  const recorded = formatRecordedDate(recording.date_recorded)
  const originalFile = recording.original_filename || recording.filename
  const provider = transcript.transcription_provider || 'unknown'
  const model = transcript.transcription_model || 'unknown'
  const title = transcript.title_suggestion?.trim() || basename(recording.filename, extname(recording.filename))
  const summary = transcript.summary?.trim()
  const wordCount = transcript.word_count ?? transcript.full_text.trim().split(/\s+/).filter(Boolean).length

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4; margin: 18mm 17mm 21mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #172033;
      font-family: "Segoe UI", Arial, sans-serif;
      font-size: 10.5pt;
      line-height: 1.58;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .accent { width: 42px; height: 4px; border-radius: 999px; background: #2563eb; margin-bottom: 16px; }
    h1 { margin: 0; color: #0f172a; font-size: 25pt; line-height: 1.18; letter-spacing: -0.02em; }
    .subtitle { margin: 8px 0 20px; color: #64748b; font-size: 10pt; }
    .metadata {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 9px 14px;
      padding: 14px 16px;
      border: 1px solid #dbe4f0;
      border-radius: 10px;
      background: #f8fafc;
      break-inside: avoid;
    }
    .label { margin-bottom: 2px; color: #64748b; font-size: 7.5pt; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .value { color: #1e293b; font-size: 9.5pt; overflow-wrap: anywhere; }
    section { margin-top: 24px; }
    h2 {
      margin: 0 0 10px;
      padding-bottom: 7px;
      border-bottom: 1px solid #dbe4f0;
      color: #0f172a;
      font-size: 14pt;
      line-height: 1.3;
    }
    .summary {
      padding: 13px 15px;
      border-left: 4px solid #3b82f6;
      border-radius: 0 8px 8px 0;
      background: #eff6ff;
      color: #1e3a5f;
      break-inside: avoid;
    }
    .transcript { overflow-wrap: anywhere; }
    .transcript p { margin: 0 0 13px; white-space: pre-wrap; break-inside: avoid; }
    .transcript p:last-child { margin-bottom: 0; }
    .source-note { margin-top: 26px; color: #64748b; font-size: 8.5pt; }
  </style>
</head>
<body>
  <div class="accent"></div>
  <h1>${escapeHtml(title)}</h1>
  <p class="subtitle">HiDock Next transcript export</p>
  <div class="metadata">
    <div><div class="label">Recorded</div><div class="value">${escapeHtml(recorded.display)}</div></div>
    <div><div class="label">Original timestamp</div><div class="value">${escapeHtml(recorded.iso)}</div></div>
    <div><div class="label">Original file</div><div class="value">${escapeHtml(originalFile)}</div></div>
    <div><div class="label">Transcription</div><div class="value">${escapeHtml(provider)} / ${escapeHtml(model)}</div></div>
    <div><div class="label">Words</div><div class="value">${wordCount.toLocaleString('en-US')}</div></div>
  </div>
  ${summary ? `<section><h2>Summary</h2><div class="summary">${escapeHtml(summary)}</div></section>` : ''}
  <section><h2>Transcript</h2><div class="transcript">${formatTranscriptParagraphs(transcript.full_text)}</div></section>
  <p class="source-note">Exported from HiDock Next. The recorded date above comes from the source recording, not the export date.</p>
</body>
</html>`
}

export async function createTranscriptPdfBuffer(recording: Recording, transcript: Transcript): Promise<Buffer> {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  try {
    const html = buildTranscriptPdfHtml(recording, transcript)
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    return await window.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `
        <div style="width:100%;padding:0 17mm;color:#64748b;font:8px Segoe UI,Arial,sans-serif;display:flex;justify-content:space-between;">
          <span>HiDock Next</span>
          <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
        </div>`
    })
  } finally {
    if (!window.isDestroyed()) window.destroy()
  }
}
