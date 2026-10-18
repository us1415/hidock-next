
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Settings } from '../Settings'

const mockLoadConfig = vi.fn()
const mockUpdateConfig = vi.fn()
const mockSyncCalendar = vi.fn()
const mockCreateBackup = vi.fn().mockResolvedValue({
  success: true,
  backupPath: 'C:\\backups\\hidock-next-backup-20261018T170000Z',
  fileCount: 3,
  totalBytes: 1024
})
const mockValidateBackup = vi.fn().mockResolvedValue({
  success: true,
  validation: { valid: true, errors: [], warnings: [], fileCount: 3, totalBytes: 1024 }
})
const mockRestoreBackup = vi.fn().mockResolvedValue({ success: false, canceled: true })
const mockPreviewOtter = vi.fn().mockResolvedValue({
  success: true,
  preview: {
    archivePath: 'C:\\exports\\otter.zip',
    archiveFilename: 'otter.zip',
    archiveBytes: 1000,
    scannedAt: '2026-10-18T17:00:00.000Z',
    counts: {
      total: 642,
      ready: 400,
      dateReview: 239,
      missingTranscript: 3,
      duplicate: 0,
      audioFiles: 642,
      transcriptFiles: 639,
      summaryFiles: 642,
      uniqueSpeakers: 25
    },
    speakers: [],
    items: []
  }
})
const mockCommitOtter = vi.fn()
const mockSaveOtterReconciliationReviews = vi.fn().mockResolvedValue({ success: true, saved: 2 })
const mockPreviewOtterReconciliation = vi.fn().mockResolvedValue({
  success: true,
  preview: {
    generatedAt: '2026-10-18T18:00:00.000Z',
    deviceInventoryStart: '2025-11-24T16:29:33.000Z',
    deviceInventoryEnd: '2026-10-16T17:02:15.000Z',
    counts: {
      deviceRecordings: 629,
      importedOtter: 641,
      importedMissingTranscript: 3,
      importedMissingTranscriptUsableAudio: 0,
      importedMissingTranscriptUnusableAudio: 3,
      preDeviceOtterOnly: 240,
      overlappingOtter: 401,
      exactTimestampMatches: 206,
      dateDurationMatches: 161,
      adjacentDateDurationMatches: 12,
      provisionalMatches: 379,
      unresolvedOverlapping: 22,
      deviceWithoutOtterMatch: 250,
      reviewedConfirmed: 0,
      reviewedSeparate: 0,
      reviewPending: 401
    },
    matches: [{
      importedRecordingId: 'match-1',
      importedFilename: 'Vendor planning.mp3',
      deviceFilename: '2026Oct16-102913-Rec21.hda',
      deviceRecordedAt: '2026-10-16T15:29:13.000Z',
      method: 'exact-timestamp',
      confidence: 1,
      reviewDecision: 'pending'
    }],
    unresolved: [{
      importedRecordingId: 'unresolved-1',
      importedFilename: 'Needs fingerprint.mp3',
      recordedDate: '2026-01-05',
      durationSeconds: 300,
      nearestCandidates: [],
      reviewDecision: 'pending'
    }]
  }
})
const mockConfig = {
  calendar: {
    icsUrl: 'https://example.com/cal.ics',
    syncEnabled: true,
    syncIntervalMinutes: 15,
    lastSyncAt: '2026-03-01T10:00:00Z'
  },
  transcription: {
    provider: 'gemini' as const,
    geminiApiKey: 'AIzaTestKey12345',
    geminiModel: 'gemini-3-pro-preview',
    openaiApiKey: '',
    openaiTranscriptionModel: 'gpt-transcribe',
    openaiAnalysisModel: 'gpt-6-luna'
  },
  chat: { provider: 'gemini' as const },
  embeddings: { ollamaBaseUrl: 'http://localhost:11434' }
}

// Mock the stores
vi.mock('@/store/useAppStore', () => ({
  useAppStore: vi.fn((selector) => {
    const state = {
      syncCalendar: mockSyncCalendar,
      calendarSyncing: false
    }
    if (typeof selector === 'function') return selector(state)
    return state
  }),
  useCalendarSyncing: vi.fn(() => false)
}))

vi.mock('@/store/domain/useConfigStore', () => ({
  useConfigStore: vi.fn((selector?: any) => {
    const state = {
      config: mockConfig,
      loadConfig: mockLoadConfig,
      updateConfig: mockUpdateConfig,
      configLoading: false
    }
    if (typeof selector === 'function') return selector(state)
    return state
  })
}))

// Mock HealthCheck component
vi.mock('@/components/HealthCheck', () => ({
  HealthCheck: () => <div data-testid="health-check">Health Check</div>
}))

// Mock Electron API
global.window.electronAPI = {
  imports: {
    previewOtter: mockPreviewOtter,
    commitOtter: mockCommitOtter,
    previewOtterReconciliation: mockPreviewOtterReconciliation,
    saveOtterReconciliationReviews: mockSaveOtterReconciliationReviews
  },
  config: {
    get: vi.fn().mockResolvedValue({
      success: true,
      data: {
        calendar: { icsUrl: '', syncEnabled: true, syncIntervalMinutes: 15 },
        transcription: {
          provider: 'gemini',
          geminiApiKey: '',
          geminiModel: 'gemini-3-pro-preview',
          openaiApiKey: '',
          openaiTranscriptionModel: 'gpt-transcribe',
          openaiAnalysisModel: 'gpt-6-luna'
        },
        chat: { provider: 'gemini' },
        embeddings: { ollamaBaseUrl: 'http://localhost:11434' }
      }
    }),
    updateSection: vi.fn().mockResolvedValue({ success: true })
  },
  storage: {
    getInfo: vi.fn().mockResolvedValue({
      success: true,
      data: {
        dataPath: '/data',
        recordingsPath: '/recordings',
        transcriptsPath: '/transcripts',
        cachePath: '/cache',
        databasePath: '/db',
        totalSizeBytes: 1024000,
        recordingsCount: 5
      }
    }),
    openFolder: vi.fn(),
    createBackup: mockCreateBackup,
    validateBackup: mockValidateBackup,
    restoreBackup: mockRestoreBackup
  },
  rag: {
    status: vi.fn().mockResolvedValue({
      success: true,
      data: { ollamaAvailable: true, documentCount: 0, meetingCount: 0, ready: true }
    })
  }
} as any

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Settings Page', () => {
  it('should render settings sections', async () => {
    render(<Settings />)

    expect(screen.getByText('Calendar')).toBeInTheDocument()
    expect(screen.getByText('AI Service Status')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Transcription' })).toBeInTheDocument()
    expect(screen.getByText('Chat / RAG')).toBeInTheDocument()
    expect(screen.getByText('Storage')).toBeInTheDocument()
  })

  it('shows transcription and local-search readiness separately', async () => {
    render(<Settings />)

    expect(screen.getByText('Configured')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument())
    expect(screen.getByText('Ollama · optional and does not block transcription')).toBeInTheDocument()
  })

  it('should render calendar settings form', async () => {
    render(<Settings />)

    expect(screen.getByLabelText('ICS Calendar URL')).toBeInTheDocument()
    expect(screen.getByLabelText('Enable auto-sync')).toBeInTheDocument()
    expect(screen.getByLabelText('Sync interval in minutes')).toBeInTheDocument()
  })

  it('should render transcription settings form', async () => {
    render(<Settings />)

    expect(screen.getByLabelText('Gemini API Key')).toBeInTheDocument()
    expect(screen.getByLabelText('Transcription Model')).toBeInTheDocument()
  })

  it('should show OpenAI settings when OpenAI is selected', async () => {
    render(<Settings />)

    await waitFor(() => expect(mockLoadConfig).toHaveBeenCalled())
    fireEvent.click(screen.getByLabelText('Use OpenAI transcription provider'))

    expect(await screen.findByLabelText('OpenAI API Key')).toBeInTheDocument()
    expect(screen.getByDisplayValue('GPT Transcribe (Recommended)')).toBeInTheDocument()
    expect(screen.getByText(/Estimated audio cost: \$0\.0045\/minute.*\$0\.14 for 30 minutes.*\$0\.27 per hour/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Gemini API Key')).not.toBeInTheDocument()
  })

  it('should render chat provider toggle buttons', async () => {
    render(<Settings />)

    expect(screen.getByLabelText('Use Gemini chat provider')).toBeInTheDocument()
    expect(screen.getByLabelText('Use Ollama local chat provider')).toBeInTheDocument()
  })

  it('should render save buttons for each section', async () => {
    render(<Settings />)

    const saveButtons = screen.getAllByLabelText(/Save.*settings/)
    expect(saveButtons.length).toBe(3) // Calendar, Transcription, Chat
  })

  it('should render storage section', async () => {
    render(<Settings />)

    expect(screen.getByText('Storage')).toBeInTheDocument()
    expect(screen.getByText('Local data storage information')).toBeInTheDocument()
  })

  it('creates, validates, and starts portable backup restore from Storage settings', async () => {
    render(<Settings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Create Backup' }))
    await waitFor(() => expect(mockCreateBackup).toHaveBeenCalledOnce())

    fireEvent.click(screen.getByRole('button', { name: 'Validate Backup' }))
    await waitFor(() => expect(mockValidateBackup).toHaveBeenCalledOnce())

    fireEvent.click(screen.getByRole('button', { name: 'Restore Backup' }))
    await waitFor(() => expect(mockRestoreBackup).toHaveBeenCalledOnce())
    expect(screen.getByText(/API keys are intentionally excluded/)).toBeInTheDocument()
    expect(screen.getByText(/creates a safety copy of the current library/)).toBeInTheDocument()
  })

  it('inspects an Otter export without starting an import', async () => {
    render(<Settings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Inspect Otter Export' }))

    await waitFor(() => expect(mockPreviewOtter).toHaveBeenCalledOnce())
    expect(screen.getByText('otter.zip')).toBeInTheDocument()
    expect(screen.getByText('642')).toBeInTheDocument()
    expect(screen.getByText(/ZIP\/export timestamp is never used/)).toBeInTheDocument()
  })

  it('previews Otter-to-HiDock reconciliation without offering a merge action', async () => {
    render(<Settings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Preview HiDock Reconciliation' }))

    await waitFor(() => expect(mockPreviewOtterReconciliation).toHaveBeenCalledOnce())
    expect(screen.getByText('629')).toBeInTheDocument()
    expect(screen.getByText('379')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Unresolved (1)' }))
    expect(screen.getByText(/Needs fingerprint\.mp3/)).toBeInTheDocument()
    expect(screen.getByText(/preview is read-only/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /merge/i })).not.toBeInTheDocument()
  })

  it('reviews and persistently saves a non-destructive reconciliation plan', async () => {
    render(<Settings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Preview HiDock Reconciliation' }))
    await screen.findByText('Vendor planning.mp3')

    fireEvent.click(screen.getByRole('button', { name: 'Confirm match' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save Review Plan' }))

    await waitFor(() => expect(mockSaveOtterReconciliationReviews).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          importedRecordingId: 'match-1',
          deviceFilename: '2026Oct16-102913-Rec21.hda',
          decision: 'confirmed',
          matchMethod: 'exact-timestamp'
        }),
        expect.objectContaining({
          importedRecordingId: 'unresolved-1',
          deviceFilename: null,
          decision: 'pending',
          matchMethod: null
        })
      ])
    ))
    expect(screen.queryByRole('button', { name: /merge/i })).not.toBeInTheDocument()
  })

  it('should render health check component', async () => {
    render(<Settings />)

    expect(screen.getByTestId('health-check')).toBeInTheDocument()
  })

  // C-006: API key visibility toggle
  it('should toggle API key visibility', async () => {
    render(<Settings />)

    const apiKeyInput = screen.getByLabelText('Gemini API Key') as HTMLInputElement

    // Default: password type
    expect(apiKeyInput.type).toBe('password')

    // Click show API key button
    const toggleButton = screen.getByLabelText('Show API key')
    fireEvent.click(toggleButton)

    // Should now be visible
    expect(apiKeyInput.type).toBe('text')

    // Click hide API key button
    const hideButton = screen.getByLabelText('Hide API key')
    fireEvent.click(hideButton)

    // Should be hidden again
    expect(apiKeyInput.type).toBe('password')
  })

  // C-006: Sync interval clamping - HTML attributes enforce valid range
  it('should render sync interval input with min/max attributes', async () => {
    render(<Settings />)

    const intervalInput = screen.getByLabelText('Sync interval in minutes') as HTMLInputElement

    // Should initialize with the config value
    expect(intervalInput.value).toBe('15')

    // Verify the input has proper min/max attributes for HTML validation
    expect(intervalInput.min).toBe('5')
    expect(intervalInput.max).toBe('120')

    // Verify input type is number
    expect(intervalInput.type).toBe('number')
  })

  // C-006: Checkbox has no redundant onKeyDown (verified by inspection; test native behavior)
  it('should render sync checkbox with onChange handler', async () => {
    render(<Settings />)

    const checkbox = screen.getByLabelText('Enable auto-sync') as HTMLInputElement

    // Default from mock config
    expect(checkbox.checked).toBe(true)

    // The checkbox should be a controlled component with only onChange,
    // not a redundant onKeyDown handler
    expect(checkbox).toBeInTheDocument()
    expect(checkbox.type).toBe('checkbox')
  })

  // C-006: Last sync time display
  it('should display last sync time when available', async () => {
    render(<Settings />)

    // The mock config has lastSyncAt set to '2026-03-01T10:00:00Z'
    expect(screen.getByText(/Last synced:/)).toBeInTheDocument()
  })
})
