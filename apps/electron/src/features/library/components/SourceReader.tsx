/**
 * SourceReader Component
 *
 * Displays the selected recording in the center panel with:
 * - Audio playback controls
 * - Transcript viewer with timestamps
 * - Metadata display (editable when knowledgeCaptureId is present)
 *
 * Shows a placeholder message when no recording is selected.
 */

import { useState, useEffect, useCallback } from 'react'
import { TranscriptViewer } from './TranscriptViewer'
import { AudioPlayer } from '@/components/AudioPlayer'
import { UnifiedRecording, hasLocalPath, isDeviceOnly } from '@/types/unified-recording'
import { Transcript, Meeting, parseJsonArray } from '@/types'
import {
  Calendar,
  Download,
  Trash2,
  Wand2,
  RefreshCw,
  Play,
  Square,
  Pencil,
  Check,
  Edit2,
  Link,
  X,
  FileDown,
  ListPlus
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem
} from '@/components/ui/select'
import { toast } from '@/components/ui/toaster'
import { RecordingLinkDialog } from '@/components/RecordingLinkDialog'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { formatDateTime, formatDuration, formatBytes, formatSourceDateTime } from '@/lib/utils'
import { getDisplayTitle } from '@/features/library/utils/getDisplayTitle'

const CATEGORY_OPTIONS = [
  { value: 'meeting', label: 'Meeting' },
  { value: 'interview', label: 'Interview' },
  { value: '1:1', label: '1:1' },
  { value: 'brainstorm', label: 'Brainstorm' },
  { value: 'note', label: 'Note' },
  { value: 'other', label: 'Other' },
] as const

interface SourceReaderProps {
  recording: UnifiedRecording | null
  transcript?: Transcript
  meeting?: Meeting
  isPlaying?: boolean
  currentTimeMs?: number
  onPlay?: () => void
  onStop?: () => void
  onSeek?: (startMs: number, endMs?: number) => void
  // Action button callbacks
  onDownload?: () => void
  onTranscribe?: () => void
  onDelete?: () => void
  onReviewStatusChange?: (status: 'new' | 'dismissed') => void
  // State for button enabling/disabling
  deviceConnected?: boolean
  isDownloading?: boolean
  downloadProgress?: number
  isDeleting?: boolean
  isUpdatingReviewStatus?: boolean
  // Navigation
  onNavigateToMeeting?: (meetingId: string) => void
  // Metadata editing callback
  onMetadataEdited?: () => void
}

interface TranscriptionHistoryItem {
  id: string
  provider: string
  model: string
  attempt: number
  status: 'processing' | 'completed' | 'failed' | 'cancelled'
  started_at: string
  completed_at: string | null
  elapsed_ms: number | null
  error_message: string | null
}

function formatElapsed(elapsedMs: number | null): string {
  if (elapsedMs === null) return 'In progress'
  const seconds = Math.max(0, Math.round(elapsedMs / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function SourceReader({
  recording,
  transcript,
  meeting,
  isPlaying = false,
  currentTimeMs = 0,
  onPlay,
  onStop,
  onSeek,
  onDownload,
  onTranscribe,
  onDelete,
  onReviewStatusChange,
  deviceConnected = false,
  isDownloading = false,
  downloadProgress,
  isDeleting = false,
  isUpdatingReviewStatus = false,
  onNavigateToMeeting,
  onMetadataEdited
}: SourceReaderProps) {

  const displayTitle = recording ? getDisplayTitle(recording, meeting, transcript) : null

  // Title editing state
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [editedTitle, setEditedTitle] = useState('')
  const [isSavingTitle, setIsSavingTitle] = useState(false)
  const [exportingFormat, setExportingFormat] = useState<'markdown' | 'text' | 'pdf' | null>(null)
  const [transcriptionHistory, setTranscriptionHistory] = useState<TranscriptionHistoryItem[]>([])

  const handleExportTranscript = useCallback(async (format: 'markdown' | 'text' | 'pdf') => {
    if (!recording || !transcript) return
    setExportingFormat(format)
    try {
      const result = await window.electronAPI.transcripts.export(recording.id, format)
      if (result.success) {
        toast.success('Transcript exported', result.filePath)
      } else if (!result.canceled) {
        toast.error('Export failed', result.error || 'Could not export transcript')
      }
    } catch (error) {
      toast.error('Export failed', error instanceof Error ? error.message : 'Could not export transcript')
    } finally {
      setExportingFormat(null)
    }
  }, [recording, transcript])

  // Category saving state
  const [isSavingCategory, setIsSavingCategory] = useState(false)

  // Meeting link dialog state
  const [linkDialogOpen, setLinkDialogOpen] = useState(false)

  // Transcription warning state
  const [metadataEdited, setMetadataEdited] = useState(false)
  const [showTranscribeWarning, setShowTranscribeWarning] = useState(false)

  // Reset all state when recording changes
  useEffect(() => {
    setIsEditingTitle(false)
    setEditedTitle('')
    setLinkDialogOpen(false)
    setMetadataEdited(false)
    setShowTranscribeWarning(false)
  }, [recording?.id])

  useEffect(() => {
    let active = true
    setTranscriptionHistory([])
    if (!recording?.id) return () => { active = false }
    const loadHistory = window.electronAPI?.recordings?.getTranscriptionHistory
    if (!loadHistory) return () => { active = false }

    loadHistory(recording.id)
      .then((items) => {
        if (active) setTranscriptionHistory(items)
      })
      .catch((error) => {
        console.error('Failed to load transcription history:', error)
      })

    return () => { active = false }
  }, [recording?.id, recording?.transcriptionStatus])

  const handleSaveTitle = useCallback(async () => {
    if (!recording?.knowledgeCaptureId) return
    const trimmed = editedTitle.trim()
    if (!trimmed) {
      setEditedTitle(displayTitle?.primaryText || recording.filename)
      toast.error('Title cannot be empty')
      return
    }
    if (trimmed === (displayTitle?.primaryText || recording.filename)) {
      setIsEditingTitle(false)
      return
    }
    setIsSavingTitle(true)
    try {
      const result = await window.electronAPI.knowledge.update(
        recording.knowledgeCaptureId,
        { title: trimmed }
      )
      if (result.success) {
        setIsEditingTitle(false)
        setMetadataEdited(true)
        toast.success('Title updated')
        onMetadataEdited?.()
      } else {
        toast.error('Failed to save title')
      }
    } catch (err) {
      console.error('Failed to save title:', err)
      toast.error('Failed to save title')
    } finally {
      setIsSavingTitle(false)
    }
  }, [displayTitle?.primaryText, editedTitle, recording, onMetadataEdited])

  const handleCancelTitle = useCallback(() => {
    setIsEditingTitle(false)
    setEditedTitle('')
  }, [])

  const handleCategoryChange = useCallback(async (newCategory: string) => {
    if (!recording?.knowledgeCaptureId) return
    if (newCategory === recording.category) return
    setIsSavingCategory(true)
    try {
      const result = await window.electronAPI.knowledge.update(
        recording.knowledgeCaptureId,
        { category: newCategory }
      )
      if (result.success) {
        setMetadataEdited(true)
        toast.success('Category updated')
        onMetadataEdited?.()
      } else {
        toast.error('Failed to save category')
      }
    } catch (err) {
      console.error('Failed to save category:', err)
      toast.error('Failed to save category')
    } finally {
      setIsSavingCategory(false)
    }
  }, [recording, onMetadataEdited])

  const handleRemoveMeetingLink = useCallback(async () => {
    if (!recording) return
    try {
      await window.electronAPI.recordings.selectMeeting(recording.id, null)
      setMetadataEdited(true)
      onMetadataEdited?.()
    } catch (err) {
      console.error('Failed to remove meeting link:', err)
      toast.error('Failed to remove meeting link')
    }
  }, [recording, onMetadataEdited])

  const handleTranscribeClick = useCallback(() => {
    if (metadataEdited) {
      setShowTranscribeWarning(true)
    } else {
      onTranscribe?.()
    }
  }, [metadataEdited, onTranscribe])

  if (!recording) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <div className="text-center space-y-2">
          <p className="text-lg font-medium">No recording selected</p>
          <p className="text-sm">Select a recording from the list to view details</p>
        </div>
      </div>
    )
  }

  const canPlay = hasLocalPath(recording)

  const linkDialogRecording = {
    id: recording.id,
    filename: recording.filename,
    date_recorded: recording.sourceDatePrecision === 'date-only' || recording.sourceDatePrecision === 'unknown'
      ? ''
      : recording.sourceDateValue ?? recording.dateRecorded?.toISOString() ?? '',
    duration_seconds: recording.duration ?? null
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header with comprehensive metadata */}
      <div className="p-6 border-b space-y-4">
        <div>
          <div className="mb-4">
            {isEditingTitle ? (
              <div className="flex items-center gap-2">
                <Input
                  value={editedTitle}
                  onChange={(e) => setEditedTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveTitle()
                    if (e.key === 'Escape') handleCancelTitle()
                  }}
                  className="text-xl font-semibold h-auto py-1"
                  autoFocus
                  disabled={isSavingTitle}
                  aria-label="Recording title"
                />
                <Button variant="ghost" size="sm" onClick={handleSaveTitle} disabled={isSavingTitle} aria-label="Save title" title="Save (Enter)">
                  <Check className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={handleCancelTitle} disabled={isSavingTitle} aria-label="Cancel editing" title="Cancel (Escape)">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <div className="group flex items-center gap-2">
                <h2 className="text-xl font-semibold truncate" title={displayTitle?.primaryText}>
                  {displayTitle?.primaryText}
                </h2>
                {recording.knowledgeCaptureId && (
                  <button
                    onClick={() => {
                      setIsEditingTitle(true)
                      setEditedTitle(displayTitle?.primaryText || recording.filename)
                    }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-muted"
                    aria-label="Edit title"
                    title="Edit title"
                  >
                    <Pencil className="h-4 w-4 text-muted-foreground" />
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Comprehensive Metadata Grid - same as SourceRowExpanded */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Date Recorded</p>
              <p>{formatSourceDateTime(
                recording.sourceDateValue ?? recording.dateRecorded?.toISOString(),
                recording.sourceDatePrecision
              )}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Duration</p>
              <p>{recording.duration ? formatDuration(recording.duration) : 'Unknown'}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Size</p>
              <p>{recording.size ? formatBytes(recording.size) : 'Unknown'}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Quality</p>
              <p className="capitalize">{recording.quality || 'Standard'}</p>
            </div>
            {recording.knowledgeCaptureId ? (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Category</p>
                <Select
                  value={recording.category || ''}
                  onValueChange={handleCategoryChange}
                  disabled={isSavingCategory}
                >
                  <SelectTrigger className="h-7 text-sm w-[140px]">
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : recording.category ? (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Category</p>
                <p className="capitalize">{recording.category}</p>
              </div>
            ) : null}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Location</p>
              <p className="capitalize">{recording.location.replace('-', ' ')}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Transcription</p>
              <p className="capitalize">{recording.transcriptionStatus}</p>
            </div>
            {displayTitle?.source !== 'filename' && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Filename</p>
                <p className="truncate" title={recording.filename}>{recording.filename}</p>
              </div>
            )}
          </div>

          {/* Linked Meeting */}
          {meeting && (
            <div className="mt-4 flex items-center gap-2 p-3 bg-muted/30 border rounded-lg">
              <div
                className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer hover:opacity-80 transition-opacity"
                onClick={() => onNavigateToMeeting?.(meeting.id)}
              >
                <Calendar className="h-4 w-4 text-primary shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{meeting.subject}</p>
                  <p className="text-xs text-muted-foreground">{formatDateTime(meeting.start_time)}</p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={(e) => { e.stopPropagation(); setLinkDialogOpen(true) }}
                title="Change linked meeting"
              >
                <Edit2 className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={(e) => { e.stopPropagation(); handleRemoveMeetingLink() }}
                title="Remove meeting link"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}

          {transcriptionHistory.length > 0 && (
            <div className="mt-4 p-3 bg-muted/30 border rounded-lg">
              <p className="text-xs font-medium text-muted-foreground mb-2">Processing history</p>
              <div className="space-y-2">
                {transcriptionHistory.slice(0, 5).map((item) => (
                  <div key={item.id} className="flex items-start justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <p className="font-medium capitalize">
                        {item.status} · {item.provider} / {item.model}
                      </p>
                      <p className="text-muted-foreground">
                        {formatDateTime(item.started_at)} · attempt {item.attempt}
                      </p>
                      {item.error_message && (
                        <p className="text-destructive mt-1 break-words">{item.error_message}</p>
                      )}
                    </div>
                    <span className="shrink-0 text-muted-foreground">{formatElapsed(item.elapsed_ms)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Transcript Summary */}
          {transcript?.summary && (
            <div className="mt-4 p-3 bg-muted/30 border rounded-lg">
              <p className="text-xs font-medium text-muted-foreground mb-2">Summary</p>
              <p className="text-sm leading-relaxed">{transcript.summary}</p>
            </div>
          )}

          {/* Device-only notice */}
          {isDeviceOnly(recording) && (
            <p className="mt-3 text-xs text-muted-foreground italic">
              Download this capture to play it and generate a transcript.
            </p>
          )}
        </div>
      </div>

      {/* Action Buttons Section */}
      <div className="flex flex-wrap gap-2 px-6 py-3 border-b bg-muted/30">
        {recording.reviewStatus === 'new' && onReviewStatusChange && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onReviewStatusChange('dismissed')}
            disabled={isUpdatingReviewStatus}
            className="gap-2"
            title="Remove from Review without downloading, transcribing, or deleting the recording"
          >
            {isUpdatingReviewStatus ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            Mark Reviewed
          </Button>
        )}

        {recording.reviewStatus === 'dismissed' && onReviewStatusChange && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onReviewStatusChange('new')}
            disabled={isUpdatingReviewStatus}
            className="gap-2"
            title="Return this recording to the Review queue"
          >
            {isUpdatingReviewStatus ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <ListPlus className="h-4 w-4" />
            )}
            Add to Review
          </Button>
        )}

        {/* Play/Stop Button - only for local recordings - LB-03 fix: Wire up onPlay callback */}
        {canPlay && onPlay && (
          isPlaying ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onStop}
              className="gap-2"
              title="Stop playback"
            >
              <Square className="h-4 w-4" />
              Stop
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={onPlay}
              className="gap-2"
              title="Play recording"
            >
              <Play className="h-4 w-4" />
              Play
            </Button>
          )
        )}

        {/* Link Meeting Button - only when no meeting linked */}
        {!meeting && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLinkDialogOpen(true)}
            className="gap-2"
            title="Link this recording to a meeting"
          >
            <Link className="h-4 w-4" />
            Link Meeting
          </Button>
        )}

        {/* Download Button - only for device-only recordings */}
        {isDeviceOnly(recording) && onDownload && (
          <Button
            variant="outline"
            size="sm"
            onClick={onDownload}
            disabled={!deviceConnected || isDownloading}
            className="gap-2"
            title={!deviceConnected ? "Device not connected" : "Download recording from device"}
          >
            {isDownloading ? (
              <>
                <RefreshCw className="h-4 w-4 animate-spin" />
                {downloadProgress !== undefined ? `${downloadProgress}%` : 'Downloading...'}
              </>
            ) : (
              <>
                <Download className="h-4 w-4" />
                Download
              </>
            )}
          </Button>
        )}

        {/* Transcribe Button - only for local recordings without transcript */}
        {hasLocalPath(recording) && recording.transcriptionStatus !== 'complete' && onTranscribe && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleTranscribeClick}
            disabled={recording.transcriptionStatus === 'pending' || recording.transcriptionStatus === 'processing'}
            className="gap-2"
            title={
              recording.transcriptionStatus === 'pending' ? "Transcription queued" :
              recording.transcriptionStatus === 'processing' ? "Transcription in progress" :
              "Start AI transcription"
            }
          >
            {recording.transcriptionStatus === 'processing' ? (
              <>
                <RefreshCw className="h-4 w-4 animate-spin" />
                In Progress
              </>
            ) : recording.transcriptionStatus === 'pending' ? (
              <>
                <RefreshCw className="h-4 w-4" />
                Queued
              </>
            ) : (
              <>
                <Wand2 className="h-4 w-4" />
                Transcribe
              </>
            )}
          </Button>
        )}

        {transcript && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleExportTranscript('pdf')}
              disabled={exportingFormat !== null}
              className="gap-2"
              title="Export a polished PDF with the original recording date"
            >
              {exportingFormat === 'pdf' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
              Export PDF
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleExportTranscript('markdown')}
              disabled={exportingFormat !== null}
              className="gap-2"
              title="Export transcript as Markdown with the original recording date"
            >
              {exportingFormat === 'markdown' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
              Export .md
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleExportTranscript('text')}
              disabled={exportingFormat !== null}
              className="gap-2"
              title="Export transcript as plain text with the original recording date"
            >
              {exportingFormat === 'text' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
              Export .txt
            </Button>
          </>
        )}

        {/* Delete Button - always available */}
        {onDelete && (
          <Button
            variant="outline"
            size="sm"
            onClick={onDelete}
            disabled={(isDeviceOnly(recording) && !deviceConnected) || isDeleting}
            className="gap-2 text-destructive hover:text-destructive"
            title={
              isDeviceOnly(recording) && !deviceConnected ? "Device not connected" :
              isDeleting ? "Deleting..." :
              "Delete recording"
            }
          >
            {isDeleting ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            Delete
          </Button>
        )}
      </div>

      {/* Audio Player — only shown after playback has been initiated */}
      {canPlay && isPlaying && (
        <div className="sticky top-0 bg-background z-10 border-b">
          <AudioPlayer key={recording.id} filename={recording.filename} onClose={onStop} />
        </div>
      )}

      {/* Transcript Content */}
      <div className="flex-1 overflow-auto p-4">
        {transcript ? (
          <TranscriptViewer
            transcript={transcript.full_text}
            currentTimeMs={currentTimeMs}
            onSeek={onSeek || (() => {})}
            showSummary={true}
            showActionItems={true}
            summary={transcript.summary ?? undefined}
            actionItems={parseJsonArray<string>(transcript.action_items)}
          />
        ) : recording.transcriptionStatus === 'complete' ? (
          <div className="text-center text-muted-foreground py-8">
            <p>Transcript not available</p>
          </div>
        ) : recording.transcriptionStatus === 'pending' || recording.transcriptionStatus === 'processing' ? (
          <div className="text-center text-muted-foreground py-8">
            <p>Transcription in progress...</p>
          </div>
        ) : (
          <div className="text-center text-muted-foreground py-8">
            <p>No transcript available</p>
            {canPlay && (
              <p className="text-sm mt-2">
                Click &quot;Transcribe&quot; to generate a transcript
              </p>
            )}
          </div>
        )}
      </div>

      {/* Meeting link dialog */}
      <RecordingLinkDialog
        recording={linkDialogOpen ? linkDialogRecording : null}
        meeting={meeting}
        open={linkDialogOpen}
        onClose={() => setLinkDialogOpen(false)}
        onResolved={() => {
          // Note: RecordingLinkDialog calls both onResolved and onClose internally
          // Do NOT call setLinkDialogOpen(false) here to avoid double-close
          setMetadataEdited(true)
          onMetadataEdited?.()
        }}
      />

      {/* Transcription overwrite warning */}
      <ConfirmDialog
        open={showTranscribeWarning}
        onOpenChange={(open) => setShowTranscribeWarning(open)}
        title="Transcription may overwrite your edits"
        description="You've manually edited this recording's metadata. The AI transcription process may overwrite your title, category, and summary changes. Do you want to continue?"
        actionLabel="Continue"
        cancelLabel="Cancel"
        variant="default"
        onConfirm={() => {
          onTranscribe?.()
          setMetadataEdited(false)
          setShowTranscribeWarning(false)
        }}
      />
    </div>
  )
}
