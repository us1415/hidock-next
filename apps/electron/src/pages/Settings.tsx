import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  Save,
  FolderOpen,
  RefreshCw,
  AlertCircle,
  Eye,
  EyeOff,
  CheckCircle2,
  WifiOff,
  Archive,
  ShieldCheck,
  RotateCcw,
  FileArchive,
  Link2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { useAppStore, useCalendarSyncing } from '@/store/useAppStore'
import { useConfigStore } from '@/store/domain/useConfigStore'
import { formatBytes } from '@/lib/utils'
import { HealthCheck } from '@/components/HealthCheck'
import { toast } from '@/components/ui/toaster'
import type { StorageInfo, AppConfig } from '@/types'
import { getOpenAITranscriptionPricingSummary } from '@/utils/transcriptionPricing'

// RAG configuration constants — MAX_CONTEXT_CHUNKS must match config.ts default (10)
const RAG_DEFAULTS = {
  MAX_CONTEXT_CHUNKS: 10,
  MIN_CONTEXT_CHUNKS: 1,
  MAX_CONTEXT_CHUNKS_LIMIT: 20
} as const

const SENSITIVE_CONFIG_MASK = '••••••••'
type OtterImportPreview = NonNullable<
  Awaited<ReturnType<Window['electronAPI']['imports']['previewOtter']>>['preview']
>
type OtterReconciliationPreview = NonNullable<
  Awaited<ReturnType<Window['electronAPI']['imports']['previewOtterReconciliation']>>['preview']
>
type OtterCanonicalMergePlan = NonNullable<
  Awaited<ReturnType<Window['electronAPI']['imports']['previewOtterCanonicalMerge']>>['plan']
>
type ReconciliationDecision = OtterReconciliationPreview['matches'][number]['reviewDecision']
type ReconciliationView = 'matches' | 'unresolved'
type ReconciliationMethod = 'all' | OtterReconciliationPreview['matches'][number]['method']

export function Settings() {
  // SM-09 fix: Use granular selectors
  const syncCalendar = useAppStore((s) => s.syncCalendar)
  const calendarSyncing = useCalendarSyncing()
  const { config, loadConfig, updateConfig, configLoading } = useConfigStore()
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null)
  const [storageError, setStorageError] = useState<string | null>(null) // B-SET-002: Storage error state
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Local form state
  const [icsUrl, setIcsUrl] = useState('')
  const [syncEnabled, setSyncEnabled] = useState(true)
  const [syncInterval, setSyncInterval] = useState(15)
  const [transcriptionProvider, setTranscriptionProvider] = useState<'gemini' | 'openai'>('gemini')
  const [geminiApiKey, setGeminiApiKey] = useState('')
  const [geminiModel, setGeminiModel] = useState('gemini-3-pro-preview')
  const [openaiApiKey, setOpenaiApiKey] = useState('')
  const [openaiTranscriptionModel, setOpenaiTranscriptionModel] = useState('gpt-transcribe')
  const [chatProvider, setChatProvider] = useState<'gemini' | 'ollama'>('gemini')
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434')
  const [showApiKey, setShowApiKey] = useState(false)
  const [storageLoading, setStorageLoading] = useState(false)
  const [backupBusy, setBackupBusy] = useState(false)
  const [otterBusy, setOtterBusy] = useState(false)
  const [otterPreview, setOtterPreview] = useState<OtterImportPreview | null>(null)
  const [reconciliationBusy, setReconciliationBusy] = useState(false)
  const [reconciliationPreview, setReconciliationPreview] = useState<OtterReconciliationPreview | null>(null)
  const [reconciliationDraft, setReconciliationDraft] = useState<Record<string, ReconciliationDecision>>({})
  const [reconciliationSaved, setReconciliationSaved] = useState<Record<string, ReconciliationDecision>>({})
  const [reconciliationView, setReconciliationView] = useState<ReconciliationView>('matches')
  const [reconciliationMethod, setReconciliationMethod] = useState<ReconciliationMethod>('all')
  const [reconciliationSearch, setReconciliationSearch] = useState('')
  const [reconciliationPage, setReconciliationPage] = useState(0)
  const [canonicalMergePlan, setCanonicalMergePlan] = useState<OtterCanonicalMergePlan | null>(null)
  const [localSearchStatus, setLocalSearchStatus] = useState<'checking' | 'ready' | 'offline'>('checking')
  // C-CHAT: RAG context window — default matches config.ts (10)
  const [ragContextSize, setRagContextSize] = useState<number>(RAG_DEFAULTS.MAX_CONTEXT_CHUNKS)

  const transcriptionReady = transcriptionProvider === 'openai'
    ? openaiApiKey.trim().length > 0
    : geminiApiKey.trim().length > 0

  const checkProviderStatus = useCallback(async () => {
    setLocalSearchStatus('checking')
    try {
      const status = await window.electronAPI?.rag?.status?.()
      setLocalSearchStatus(status?.success && status.data.ollamaAvailable ? 'ready' : 'offline')
    } catch {
      setLocalSearchStatus('offline')
    }
  }, [])

  // Available Gemini models for transcription (audio-capable)
  // From: https://ai.google.dev/gemini-api/docs/models
  const GEMINI_MODELS = [
    // Gemini 3 Series
    { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview (Best quality)' },
    { value: 'gemini-3-pro-image-preview', label: 'Gemini 3 Pro Image Preview' },
    { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview (Fast)' },
    // Gemini 2.5 Pro Series
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (Stable)' },
    { value: 'gemini-2.5-pro-preview-tts', label: 'Gemini 2.5 Pro TTS Preview' },
    // Gemini 2.5 Flash Series
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Stable)' },
    { value: 'gemini-2.5-flash-preview-09-2025', label: 'Gemini 2.5 Flash Preview' },
    { value: 'gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image' },
    { value: 'gemini-2.5-flash-native-audio-preview-12-2025', label: 'Gemini 2.5 Flash Native Audio (Dec 2025)' },
    { value: 'gemini-2.5-flash-native-audio-preview-09-2025', label: 'Gemini 2.5 Flash Native Audio (Sep 2025)' },
    { value: 'gemini-2.5-flash-preview-tts', label: 'Gemini 2.5 Flash TTS Preview' },
    // Gemini 2.5 Flash-Lite Series
    { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite (Stable)' },
    { value: 'gemini-2.5-flash-lite-preview-09-2025', label: 'Gemini 2.5 Flash Lite Preview' },
  ]

  // Validation function for config values
  const validateConfig = useCallback((updates: Partial<AppConfig>): string | null => {
    // Transcription settings validation
    if (updates.transcription) {
      if (updates.transcription.geminiApiKey !== undefined) {
        const apiKey = updates.transcription.geminiApiKey.trim()
        if (apiKey && apiKey !== SENSITIVE_CONFIG_MASK && apiKey.length < 10) {
          return 'API key must be at least 10 characters'
        }
        if (apiKey && apiKey !== SENSITIVE_CONFIG_MASK && !apiKey.startsWith('AIza')) {
          return 'Gemini API keys should start with "AIza". Please verify your key.'
        }
      }
      if (updates.transcription.openaiApiKey !== undefined) {
        const apiKey = updates.transcription.openaiApiKey.trim()
        if (apiKey && apiKey !== SENSITIVE_CONFIG_MASK && (apiKey.length < 20 || /\s/.test(apiKey))) {
          return 'OpenAI API key appears invalid. Please verify the key.'
        }
      }
    }

    // Calendar settings validation
    if (updates.calendar) {
      if (updates.calendar.icsUrl !== undefined) {
        const url = updates.calendar.icsUrl.trim()
        if (url && !url.startsWith('http')) {
          return 'Calendar URL must start with http:// or https://'
        }
      }
      if (updates.calendar.syncIntervalMinutes !== undefined) {
        const interval = updates.calendar.syncIntervalMinutes
        if (interval < 5 || interval > 120) {
          return 'Sync interval must be between 5 and 120 minutes'
        }
      }
    }

    // Embeddings settings validation
    if (updates.embeddings) {
      if (updates.embeddings.ollamaBaseUrl !== undefined) {
        const url = updates.embeddings.ollamaBaseUrl.trim()
        if (url && !url.startsWith('http')) {
          return 'Ollama URL must start with http:// or https://'
        }
      }
    }

    return null // Valid
  }, [])

  // C-SET: Track form dirty state per section
  const isCalendarDirty = useMemo(() => {
    if (!config) return false
    return (
      icsUrl !== config.calendar.icsUrl ||
      syncEnabled !== config.calendar.syncEnabled ||
      syncInterval !== config.calendar.syncIntervalMinutes
    )
  }, [config, icsUrl, syncEnabled, syncInterval])

  const isTranscriptionDirty = useMemo(() => {
    if (!config) return false
    return (
      transcriptionProvider !== config.transcription.provider ||
      geminiApiKey !== config.transcription.geminiApiKey ||
      geminiModel !== (config.transcription.geminiModel || 'gemini-3-pro-preview') ||
      openaiApiKey !== (config.transcription.openaiApiKey || '') ||
      openaiTranscriptionModel !== (config.transcription.openaiTranscriptionModel || 'gpt-transcribe')
    )
  }, [config, transcriptionProvider, geminiApiKey, geminiModel, openaiApiKey, openaiTranscriptionModel])

  const isChatDirty = useMemo(() => {
    if (!config) return false
    return (
      chatProvider !== config.chat.provider ||
      ollamaUrl !== config.embeddings.ollamaBaseUrl ||
      ragContextSize !== config.chat.maxContextChunks
    )
  }, [config, chatProvider, ollamaUrl, ragContextSize])

  // Stable loadConfig with useCallback for dependency array
  const loadConfigStable = useCallback(async () => {
    try {
      setLoadError(null)
      await loadConfig()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load settings'
      setLoadError(message)
      toast.error('Failed to Load Settings', message)
    }
  }, [loadConfig])

  useEffect(() => {
    loadConfigStable()
    loadStorageInfo()
  }, [loadConfigStable])

  useEffect(() => {
    if (config) {
      setIcsUrl(config.calendar.icsUrl)
      setSyncEnabled(config.calendar.syncEnabled)
      setSyncInterval(config.calendar.syncIntervalMinutes)
      setTranscriptionProvider(config.transcription.provider || 'gemini')
      setGeminiApiKey(config.transcription.geminiApiKey)
      setGeminiModel(config.transcription.geminiModel || 'gemini-3-pro-preview')
      setOpenaiApiKey(config.transcription.openaiApiKey || '')
      setOpenaiTranscriptionModel(config.transcription.openaiTranscriptionModel || 'gpt-transcribe')
      setChatProvider(config.chat.provider)
      setOllamaUrl(config.embeddings.ollamaBaseUrl)
      // C-CHAT: Load RAG context window size
      setRagContextSize(config.chat.maxContextChunks)
    }
  }, [config])

  useEffect(() => {
    void checkProviderStatus()
  }, [checkProviderStatus])

  const loadStorageInfo = async () => {
    try {
      setStorageError(null) // B-SET-002: Clear previous error
      setStorageLoading(true)
      const result = await window.electronAPI.storage.getInfo()
      if (result.success && result.data) {
        setStorageInfo(result.data)
      } else {
        // B-SET-002: Surface storage errors to user
        const errorMsg = result.error || 'Failed to load storage info'
        setStorageError(typeof errorMsg === 'string' ? errorMsg : String(errorMsg))
        console.error('Failed to load storage info:', result.error)
      }
    } catch (error) {
      // B-SET-002: Surface storage errors to user
      const errorMsg = error instanceof Error ? error.message : 'Failed to load storage info'
      setStorageError(errorMsg)
      console.error('Failed to load storage info:', error)
    } finally {
      setStorageLoading(false)
    }
  }

  const handleCreateBackup = async () => {
    setBackupBusy(true)
    try {
      const result = await window.electronAPI.storage.createBackup()
      if (result.canceled) return
      if (!result.success) {
        toast.error('Backup failed', result.error || 'Could not create the backup.')
        return
      }
      toast.success(
        'Backup created',
        `${result.fileCount || 0} files (${formatBytes(result.totalBytes || 0)}) were copied and checksummed.`
      )
    } catch (error) {
      toast.error('Backup failed', error instanceof Error ? error.message : 'Could not create the backup.')
    } finally {
      setBackupBusy(false)
    }
  }

  const handleValidateBackup = async () => {
    setBackupBusy(true)
    try {
      const result = await window.electronAPI.storage.validateBackup()
      if (result.canceled) return
      if (!result.success || !result.validation?.valid) {
        const detail = result.validation?.errors[0] || result.error || 'The backup could not be validated.'
        toast.error('Backup is not valid', detail)
        return
      }
      toast.success(
        'Backup is valid',
        `${result.validation.fileCount} files (${formatBytes(result.validation.totalBytes)}) passed checksum validation.`
      )
    } catch (error) {
      toast.error('Validation failed', error instanceof Error ? error.message : 'Could not validate the backup.')
    } finally {
      setBackupBusy(false)
    }
  }

  const handleRestoreBackup = async () => {
    setBackupBusy(true)
    try {
      const result = await window.electronAPI.storage.restoreBackup()
      if (result.canceled || result.restarting) return
      if (!result.success) {
        toast.error('Restore not started', result.error || 'Could not prepare the backup restore.')
      }
    } catch (error) {
      toast.error('Restore not started', error instanceof Error ? error.message : 'Could not prepare the backup restore.')
    } finally {
      setBackupBusy(false)
    }
  }

  const handlePreviewOtterImport = async () => {
    setOtterBusy(true)
    try {
      const result = await window.electronAPI.imports.previewOtter()
      if (result.canceled) return
      if (!result.success || !result.preview) {
        toast.error('Otter inspection failed', result.error || 'Could not inspect the Otter export.')
        return
      }
      setOtterPreview(result.preview)
      toast.success(
        'Otter export inspected',
        `${result.preview.counts.total} conversations found; no files were imported or changed.`
      )
    } catch (error) {
      toast.error('Otter inspection failed', error instanceof Error ? error.message : 'Could not inspect the export.')
    } finally {
      setOtterBusy(false)
    }
  }

  const handleCommitOtterImport = async () => {
    if (!otterPreview) return
    const eligible = otterPreview.items.filter((item) =>
      item.status !== 'duplicate' && item.sourceDatePrecision !== 'unknown'
    )
    if (eligible.length === 0) {
      toast.warning('Nothing to import', 'No non-duplicate conversations with a recoverable date are available.')
      return
    }
    const dateOnlyCount = eligible.filter((item) => item.sourceDatePrecision === 'date-only').length
    const confirmed = window.confirm(
      `Import ${eligible.length} Otter conversations?\n\n` +
      `${dateOnlyCount} have a known date but unknown time. They will remain date-only and will not be ` +
      'automatically matched to calendar meetings. Confirmed duplicates will be skipped. HiDock Next will create ' +
      'a portable safety backup automatically before importing.'
    )
    if (!confirmed) return

    setOtterBusy(true)
    try {
      const result = await window.electronAPI.imports.commitOtter(
        otterPreview.archivePath,
        eligible.map((item) => item.key)
      )
      if (!result.success || !result.result) {
        toast.error('Otter import failed', result.error || 'No conversations were imported.')
        return
      }
      toast.success(
        'Otter import complete',
        `${result.result.imported} conversations imported; ${result.result.withTranscripts} included transcripts. ` +
        'A pre-import safety backup was saved.'
      )
      setOtterPreview(null)
    } catch (error) {
      toast.error('Otter import failed', error instanceof Error ? error.message : 'No conversations were imported.')
    } finally {
      setOtterBusy(false)
    }
  }

  const handlePreviewOtterReconciliation = async () => {
    setReconciliationBusy(true)
    try {
      const result = await window.electronAPI.imports.previewOtterReconciliation()
      if (!result.success || !result.preview) {
        toast.error('Reconciliation preview failed', result.error || 'Could not compare Otter and HiDock recordings.')
        return
      }
      setReconciliationPreview(result.preview)
      const decisions = Object.fromEntries(
        [...result.preview.matches, ...result.preview.unresolved]
          .map((item) => [item.importedRecordingId, item.reviewDecision])
      ) as Record<string, ReconciliationDecision>
      setReconciliationDraft(decisions)
      setReconciliationSaved(decisions)
      setReconciliationPage(0)
      toast.success(
        'Reconciliation preview ready',
        `${result.preview.counts.provisionalMatches} provisional matches found; no recordings were changed.`
      )
    } catch (error) {
      toast.error(
        'Reconciliation preview failed',
        error instanceof Error ? error.message : 'Could not compare Otter and HiDock recordings.'
      )
    } finally {
      setReconciliationBusy(false)
    }
  }

  const setReconciliationDecision = (recordingIds: string[], decision: ReconciliationDecision) => {
    setReconciliationDraft((current) => {
      const next = { ...current }
      for (const recordingId of recordingIds) next[recordingId] = decision
      return next
    })
  }

  const reconciliationReviewItems = useMemo(() => {
    if (!reconciliationPreview) return []
    const search = reconciliationSearch.trim().toLowerCase()
    const items = reconciliationView === 'matches'
      ? reconciliationPreview.matches
          .filter((item) => reconciliationMethod === 'all' || item.method === reconciliationMethod)
          .map((item) => ({ kind: 'match' as const, item }))
      : reconciliationPreview.unresolved.map((item) => ({ kind: 'unresolved' as const, item }))
    if (!search) return items
    return items.filter(({ item }) => {
      const candidate = 'deviceFilename' in item ? item.deviceFilename : ''
      return `${item.importedFilename} ${candidate}`.toLowerCase().includes(search)
    })
  }, [reconciliationMethod, reconciliationPreview, reconciliationSearch, reconciliationView])

  const reconciliationPageSize = 20
  const reconciliationPageCount = Math.max(1, Math.ceil(reconciliationReviewItems.length / reconciliationPageSize))
  const reconciliationVisibleItems = reconciliationReviewItems.slice(
    reconciliationPage * reconciliationPageSize,
    (reconciliationPage + 1) * reconciliationPageSize
  )
  const reconciliationSummary = useMemo(() => {
    if (!reconciliationPreview) return { confirmed: 0, separate: 0, pending: 0 }
    const ids = [...reconciliationPreview.matches, ...reconciliationPreview.unresolved]
      .map((item) => item.importedRecordingId)
    return ids.reduce((summary, id) => {
      const decision = reconciliationDraft[id] || 'pending'
      summary[decision] += 1
      return summary
    }, { confirmed: 0, separate: 0, pending: 0 })
  }, [reconciliationDraft, reconciliationPreview])
  const reconciliationDirty = useMemo(() => {
    if (!reconciliationPreview) return false
    return [...reconciliationPreview.matches, ...reconciliationPreview.unresolved]
      .some((item) => (reconciliationDraft[item.importedRecordingId] || 'pending') !==
        (reconciliationSaved[item.importedRecordingId] || 'pending'))
  }, [reconciliationDraft, reconciliationPreview, reconciliationSaved])

  const handleSaveReconciliationReviews = async () => {
    if (!reconciliationPreview || !reconciliationDirty) return
    setReconciliationBusy(true)
    try {
      const reviews = [
        ...reconciliationPreview.matches.map((item) => ({
          importedRecordingId: item.importedRecordingId,
          deviceFilename: item.deviceFilename,
          decision: reconciliationDraft[item.importedRecordingId] || 'pending',
          matchMethod: item.method
        })),
        ...reconciliationPreview.unresolved.map((item) => ({
          importedRecordingId: item.importedRecordingId,
          deviceFilename: null,
          decision: reconciliationDraft[item.importedRecordingId] || 'pending',
          matchMethod: null
        }))
      ]
      const result = await window.electronAPI.imports.saveOtterReconciliationReviews(reviews)
      if (!result.success) {
        toast.error('Review plan not saved', result.error || 'Could not save reconciliation decisions.')
        return
      }
      setReconciliationSaved({ ...reconciliationDraft })
      toast.success(
        'Review plan saved',
        `${reconciliationSummary.confirmed} matches confirmed; ${reconciliationSummary.separate} kept separate. ` +
        'No recordings or transcripts were changed.'
      )
    } catch (error) {
      toast.error(
        'Review plan not saved',
        error instanceof Error ? error.message : 'Could not save reconciliation decisions.'
      )
    } finally {
      setReconciliationBusy(false)
    }
  }

  const handleCanonicalMergeDryRun = async () => {
    setReconciliationBusy(true)
    try {
      const result = await window.electronAPI.imports.previewOtterCanonicalMerge()
      if (!result.success || !result.plan) {
        toast.error('Canonical merge dry run failed', result.error || 'No merge plan was returned.')
        return
      }
      setCanonicalMergePlan(result.plan)
      if (result.plan.ready) {
        toast.success(
          'Canonical merge dry run ready',
          `${result.plan.counts.proposedAccepted} matches can be merged; ` +
          `${result.plan.counts.unresolvedKeptSeparate} will remain separate.`
        )
      } else {
        toast.warning('Canonical merge dry run has blockers', `${result.plan.counts.blockers} blockers require attention.`)
      }
    } catch (error) {
      toast.error(
        'Canonical merge dry run failed',
        error instanceof Error ? error.message : 'Could not build the canonical merge plan.'
      )
    } finally {
      setReconciliationBusy(false)
    }
  }

  const handleSaveCalendar = async () => {
    if (saving) {
      toast.warning('Please wait', 'Previous save in progress')
      return
    }

    // Store previous values for rollback
    const previousIcsUrl = config?.calendar.icsUrl || ''
    const previousSyncEnabled = config?.calendar.syncEnabled ?? true
    const previousSyncInterval = config?.calendar.syncIntervalMinutes || 15

    const updates = {
      icsUrl,
      syncEnabled,
      syncIntervalMinutes: syncInterval
    }

    // Validate before save - validateConfig accepts any shape
    const validationError = validateConfig({ calendar: updates } as Partial<AppConfig>)
    if (validationError) {
      toast.error('Validation Error', validationError)
      return
    }

    setSaving(true)
    try {
      await updateConfig('calendar', updates)

      toast.success('Settings Saved', 'Calendar settings have been updated')
    } catch (error) {
      // Rollback on error
      setIcsUrl(previousIcsUrl)
      setSyncEnabled(previousSyncEnabled)
      setSyncInterval(previousSyncInterval)

      const message = error instanceof Error ? error.message : 'Failed to save calendar settings'
      toast.error('Save Failed', message)
      console.error('Failed to save calendar settings:', error)
    } finally {
      setSaving(false)
    }
  }

  const handleSaveTranscription = async () => {
    if (saving) {
      toast.warning('Please wait', 'Previous save in progress')
      return
    }

    // Store previous values for rollback
    const previousProvider = config?.transcription.provider || 'gemini'
    const previousGeminiApiKey = config?.transcription.geminiApiKey || ''
    const previousGeminiModel = config?.transcription.geminiModel || 'gemini-3-pro-preview'
    const previousOpenaiApiKey = config?.transcription.openaiApiKey || ''
    const previousOpenaiModel = config?.transcription.openaiTranscriptionModel || 'gpt-transcribe'

    const updates = {
      provider: transcriptionProvider,
      geminiApiKey,
      geminiModel,
      openaiApiKey,
      openaiTranscriptionModel,
      openaiAnalysisModel: config?.transcription.openaiAnalysisModel || 'gpt-6-luna'
    }

    // Validate before save
    const validationError = validateConfig({ transcription: updates } as Partial<AppConfig>)
    if (validationError) {
      toast.error('Validation Error', validationError)
      return
    }

    setSaving(true)
    try {
      await updateConfig('transcription', updates)

      const model = transcriptionProvider === 'openai' ? openaiTranscriptionModel : geminiModel
      toast.success('Settings Saved', `Transcription provider set to ${model}`)
    } catch (error) {
      // Rollback on error
      setTranscriptionProvider(previousProvider)
      setGeminiApiKey(previousGeminiApiKey)
      setGeminiModel(previousGeminiModel)
      setOpenaiApiKey(previousOpenaiApiKey)
      setOpenaiTranscriptionModel(previousOpenaiModel)

      const message = error instanceof Error ? error.message : 'Failed to save transcription settings'
      toast.error('Save Failed', message)
      console.error('Failed to save transcription settings:', error)
    } finally {
      setSaving(false)
    }
  }

  const handleSaveChat = async () => {
    if (saving) {
      toast.warning('Please wait', 'Previous save in progress')
      return
    }

    // Store previous values for rollback
    const previousChatProvider = config?.chat.provider || 'gemini'
    const previousOllamaUrl = config?.embeddings.ollamaBaseUrl || 'http://localhost:11434'
    const previousContextSize = config?.chat.maxContextChunks || RAG_DEFAULTS.MAX_CONTEXT_CHUNKS

    const chatUpdates = {
      provider: chatProvider,
      maxContextChunks: ragContextSize
    }

    const embeddingsUpdates = {
      ollamaBaseUrl: ollamaUrl
    }

    // Validate before save
    const validationError = validateConfig({
      chat: chatUpdates,
      embeddings: embeddingsUpdates
    } as Partial<AppConfig>)
    if (validationError) {
      toast.error('Validation Error', validationError)
      return
    }

    setSaving(true)
    try {
      // Save both sections atomically using Promise.all to prevent partial state
      await Promise.all([
        updateConfig('chat', chatUpdates),
        updateConfig('embeddings', embeddingsUpdates)
      ])

      toast.success('Settings Saved', `Chat provider set to ${chatProvider}`)
    } catch (error) {
      // Rollback on error - both sections revert
      setChatProvider(previousChatProvider)
      setOllamaUrl(previousOllamaUrl)
      setRagContextSize(previousContextSize)
      // Reload config from backend to ensure consistency after partial failure
      try { await loadConfig() } catch { /* best effort reload */ }

      const message = error instanceof Error ? error.message : 'Failed to save chat settings'
      toast.error('Save Failed', message)
      console.error('Failed to save chat settings:', error)
    } finally {
      setSaving(false)
    }
  }

  const handleOpenFolder = async (folder: 'recordings' | 'transcripts' | 'data') => {
    await window.electronAPI.storage.openFolder(folder)
  }

  // Loading state
  if (configLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground mb-4" />
        <p className="text-muted-foreground">Loading settings...</p>
      </div>
    )
  }

  // Error state with retry
  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6">
        <AlertCircle className="h-12 w-12 text-destructive mb-4" />
        <h2 className="text-xl font-semibold mb-2">Failed to Load Settings</h2>
        <p className="text-muted-foreground mb-4 text-center max-w-md">{loadError}</p>
        <Button onClick={loadConfigStable}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <header className="border-b px-6 py-4">
        <h1 className="text-2xl font-bold">Settings</h1>
      </header>

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-2xl mx-auto space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>AI Service Status</CardTitle>
              <CardDescription>Transcription and local search operate independently</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <p className="text-sm font-medium">Transcription</p>
                  <p className="text-xs text-muted-foreground">
                    {transcriptionProvider === 'openai' ? 'OpenAI' : 'Gemini'} · {transcriptionProvider === 'openai' ? openaiTranscriptionModel : geminiModel}
                  </p>
                </div>
                <div className={`flex items-center gap-2 text-sm ${transcriptionReady ? 'text-green-600' : 'text-amber-600'}`} role="status">
                  {transcriptionReady ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
                  {transcriptionReady ? 'Configured' : 'API key needed'}
                </div>
              </div>

              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <p className="text-sm font-medium">Local search</p>
                  <p className="text-xs text-muted-foreground">Ollama · optional and does not block transcription</p>
                </div>
                <div className={`flex items-center gap-2 text-sm ${localSearchStatus === 'ready' ? 'text-green-600' : 'text-muted-foreground'}`} role="status">
                  {localSearchStatus === 'checking' ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : localSearchStatus === 'ready' ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    <WifiOff className="h-4 w-4" />
                  )}
                  {localSearchStatus === 'checking' ? 'Checking' : localSearchStatus === 'ready' ? 'Ready' : 'Offline'}
                </div>
              </div>

              <Button type="button" variant="outline" size="sm" onClick={checkProviderStatus}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh status
              </Button>
            </CardContent>
          </Card>

          {/* Calendar Settings */}
          <Card>
            <CardHeader>
              <CardTitle>Calendar</CardTitle>
              <CardDescription>Configure calendar sync from Outlook</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label htmlFor="icsUrl" className="text-sm font-medium">ICS Calendar URL</label>
                <Input
                  id="icsUrl"
                  type="url"
                  placeholder="https://outlook.office365.com/owa/calendar/.../calendar.ics"
                  value={icsUrl}
                  onChange={(e) => setIcsUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveCalendar()}
                  disabled={saving}
                  aria-label="ICS Calendar URL"
                  aria-describedby="icsUrl-description"
                  className="mt-1"
                />
                <p id="icsUrl-description" className="text-xs text-muted-foreground mt-1">
                  Publish your Outlook calendar and paste the ICS link here
                </p>
              </div>

              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="syncEnabled"
                    checked={syncEnabled}
                    onChange={(e) => setSyncEnabled(e.target.checked)}
                    disabled={saving}
                    aria-label="Enable auto-sync"
                    className="rounded"
                  />
                  <label htmlFor="syncEnabled" className="text-sm">
                    Auto-sync enabled
                  </label>
                </div>

                <div className="flex items-center gap-2">
                  <label htmlFor="syncInterval" className="text-sm">Every</label>
                  <Input
                    id="syncInterval"
                    type="number"
                    min={5}
                    max={120}
                    value={syncInterval}
                    onChange={(e) => {
                      const val = parseInt(e.target.value)
                      if (isNaN(val)) return
                      // Clamp to valid range
                      setSyncInterval(Math.min(120, Math.max(5, val)))
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveCalendar()}
                    disabled={saving}
                    aria-label="Sync interval in minutes"
                    className="w-20"
                  />
                  <span className="text-sm">minutes</span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  onClick={handleSaveCalendar}
                  disabled={saving || !isCalendarDirty}
                  aria-label="Save calendar settings"
                >
                  <Save className="h-4 w-4 mr-2" aria-hidden="true" />
                  {isCalendarDirty ? 'Save' : 'Saved'}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => syncCalendar()}
                  disabled={calendarSyncing || saving}
                  aria-label="Sync calendar now"
                >
                  <RefreshCw className={`h-4 w-4 mr-2 ${calendarSyncing ? 'animate-spin' : ''}`} aria-hidden="true" />
                  Sync Now
                </Button>
                {config?.calendar.lastSyncAt && (
                  <span className="text-xs text-muted-foreground ml-2">
                    Last synced: {new Date(config.calendar.lastSyncAt).toLocaleString()}
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Transcription Settings */}
          <Card>
            <CardHeader>
              <CardTitle>Transcription</CardTitle>
              <CardDescription>Choose and configure the service used to transcribe recordings</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label id="transcriptionProvider-label" className="text-sm font-medium">Provider</label>
                <div className="flex gap-2 mt-2" role="group" aria-labelledby="transcriptionProvider-label">
                  <Button
                    type="button"
                    variant={transcriptionProvider === 'openai' ? 'default' : 'outline'}
                    onClick={() => setTranscriptionProvider('openai')}
                    aria-label="Use OpenAI transcription provider"
                    aria-pressed={transcriptionProvider === 'openai'}
                  >
                    OpenAI
                  </Button>
                  <Button
                    type="button"
                    variant={transcriptionProvider === 'gemini' ? 'default' : 'outline'}
                    onClick={() => setTranscriptionProvider('gemini')}
                    aria-label="Use Gemini transcription provider"
                    aria-pressed={transcriptionProvider === 'gemini'}
                  >
                    Gemini
                  </Button>
                </div>
              </div>

              {transcriptionProvider === 'openai' ? (
                <>
                  <div>
                    <label htmlFor="openaiApiKey" className="text-sm font-medium">OpenAI API Key</label>
                    <div className="relative mt-1">
                      <Input
                        id="openaiApiKey"
                        type={showApiKey ? 'text' : 'password'}
                        placeholder="Enter your OpenAI API key"
                        value={openaiApiKey}
                        onChange={(e) => setOpenaiApiKey(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSaveTranscription()}
                        disabled={saving}
                        aria-label="OpenAI API Key"
                        aria-describedby="openaiApiKey-description"
                        className="pr-10"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                        onClick={() => setShowApiKey(!showApiKey)}
                        aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                        tabIndex={-1}
                      >
                        {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </div>
                    <p id="openaiApiKey-description" className="text-xs text-muted-foreground mt-1">
                      Create a key in the{' '}
                      <a
                        href="https://platform.openai.com/api-keys"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        OpenAI API platform
                      </a>
                    </p>
                  </div>

                  <div>
                    <label htmlFor="openaiTranscriptionModel" className="text-sm font-medium">Transcription Model</label>
                    <select
                      id="openaiTranscriptionModel"
                      value={openaiTranscriptionModel}
                      onChange={(e) => setOpenaiTranscriptionModel(e.target.value)}
                      disabled={saving}
                      aria-label="Transcription Model"
                      className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                    >
                      <option value="gpt-transcribe">GPT Transcribe (Recommended)</option>
                      <option value="gpt-4o-mini-transcribe">GPT-4o Mini Transcribe (Lowest cost)</option>
                      <option value="gpt-4o-transcribe">GPT-4o Transcribe</option>
                      <option value="gpt-4o-transcribe-diarize">GPT-4o Transcribe Diarize (Speaker recognition)</option>
                    </select>
                    <p className="text-xs text-muted-foreground mt-1">
                      {openaiTranscriptionModel === 'gpt-4o-transcribe-diarize'
                        ? 'Returns timestamped speaker turns and can recognize up to four known voices from local historical reference clips.'
                        : 'Large recordings are split into temporary chunks automatically and saved as one transcript.'}
                    </p>
                    {openaiTranscriptionModel === 'gpt-4o-transcribe-diarize' && (
                      <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                        Speaker recognition sends short reference clips with the recording to OpenAI. Automatic transcription remains off unless enabled separately.
                      </p>
                    )}
                    {getOpenAITranscriptionPricingSummary(openaiTranscriptionModel) && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Estimated audio cost: {getOpenAITranscriptionPricingSummary(openaiTranscriptionModel)}.
                        Transcript analysis is billed separately and varies with transcript length.
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <>
              <div>
                <label htmlFor="geminiApiKey" className="text-sm font-medium">Gemini API Key</label>
                <div className="relative mt-1">
                  <Input
                    id="geminiApiKey"
                    type={showApiKey ? 'text' : 'password'}
                    placeholder="Enter your Gemini API key"
                    value={geminiApiKey}
                    onChange={(e) => setGeminiApiKey(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveTranscription()}
                    disabled={saving}
                    aria-label="Gemini API Key"
                    aria-describedby="geminiApiKey-description"
                    className="pr-10"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                    onClick={() => setShowApiKey(!showApiKey)}
                    aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                    tabIndex={-1}
                  >
                    {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
                <p id="geminiApiKey-description" className="text-xs text-muted-foreground mt-1">
                  Get your API key from{' '}
                  <a
                    href="https://aistudio.google.com/app/apikey"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    Google AI Studio
                  </a>
                </p>
              </div>

              <div>
                <label htmlFor="geminiModel" className="text-sm font-medium">Transcription Model</label>
                <select
                  id="geminiModel"
                  value={geminiModel}
                  onChange={(e) => setGeminiModel(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveTranscription()}
                  disabled={saving}
                  aria-label="Transcription Model"
                  aria-describedby="geminiModel-description"
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                >
                  {GEMINI_MODELS.map((model) => (
                    <option key={model.value} value={model.value}>
                      {model.label}
                    </option>
                  ))}
                </select>
                <p id="geminiModel-description" className="text-xs text-muted-foreground mt-1">
                  Gemini 3 Pro provides the best transcription accuracy
                </p>
              </div>

                </>
              )}

              <Button
                onClick={handleSaveTranscription}
                disabled={saving || !isTranscriptionDirty}
                aria-label="Save transcription settings"
              >
                <Save className="h-4 w-4 mr-2" aria-hidden="true" />
                {isTranscriptionDirty ? 'Save' : 'Saved'}
              </Button>
            </CardContent>
          </Card>

          {/* Chat Settings */}
          <Card>
            <CardHeader>
              <CardTitle>Chat / RAG</CardTitle>
              <CardDescription>Configure chat provider for querying meetings</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label id="chatProvider-label" className="text-sm font-medium">Chat Provider</label>
                <div className="flex gap-2 mt-2" role="group" aria-labelledby="chatProvider-label">
                  <Button
                    variant={chatProvider === 'gemini' ? 'default' : 'outline'}
                    onClick={() => setChatProvider('gemini')}
                    onKeyDown={(e) => e.key === 'Enter' && setChatProvider('gemini')}
                    disabled={saving}
                    aria-label="Use Gemini chat provider"
                    aria-pressed={chatProvider === 'gemini'}
                  >
                    Gemini
                  </Button>
                  <Button
                    variant={chatProvider === 'ollama' ? 'default' : 'outline'}
                    onClick={() => setChatProvider('ollama')}
                    onKeyDown={(e) => e.key === 'Enter' && setChatProvider('ollama')}
                    disabled={saving}
                    aria-label="Use Ollama local chat provider"
                    aria-pressed={chatProvider === 'ollama'}
                  >
                    Ollama (Local)
                  </Button>
                </div>
              </div>

              {chatProvider === 'ollama' && (
                <div>
                  <label htmlFor="ollamaUrl" className="text-sm font-medium">Ollama URL</label>
                  <Input
                    id="ollamaUrl"
                    type="url"
                    placeholder="http://localhost:11434"
                    value={ollamaUrl}
                    onChange={(e) => setOllamaUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveChat()}
                    disabled={saving}
                    aria-label="Ollama base URL"
                    aria-describedby="ollamaUrl-description"
                    className="mt-1"
                  />
                  <p id="ollamaUrl-description" className="text-xs text-muted-foreground mt-1">
                    URL of your local Ollama server
                  </p>
                </div>
              )}

              {/* C-CHAT: RAG Context Window Size */}
              <div>
                <label htmlFor="ragContextSize" className="text-sm font-medium">
                  RAG Context Window
                </label>
                <Input
                  id="ragContextSize"
                  type="number"
                  min={1}
                  max={20}
                  value={ragContextSize}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10)
                    if (!isNaN(val)) {
                      setRagContextSize(Math.min(20, Math.max(1, val)))
                    }
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveChat()}
                  disabled={saving}
                  aria-label="RAG context window size"
                  aria-describedby="ragContextSize-description"
                  className="mt-1"
                />
                <p id="ragContextSize-description" className="text-xs text-muted-foreground mt-1">
                  Number of knowledge chunks to retrieve for context (1-20). Default: 10
                </p>
              </div>

              <Button
                onClick={handleSaveChat}
                disabled={saving || !isChatDirty}
                aria-label="Save chat settings"
              >
                <Save className="h-4 w-4 mr-2" aria-hidden="true" />
                {isChatDirty ? 'Save' : 'Saved'}
              </Button>
            </CardContent>
          </Card>

          {/* Storage */}
          <Card>
            <CardHeader>
              <CardTitle>Storage</CardTitle>
              <CardDescription>Local data storage information</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Storage loading indicator */}
              {storageLoading && !storageInfo && (
                <div className="flex items-center gap-2 py-4 justify-center">
                  <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Loading storage info...</span>
                </div>
              )}
              {/* B-SET-002: Storage error with retry button */}
              {storageError && (
                <div className="flex items-center gap-3 p-3 rounded-md bg-destructive/10 text-destructive border border-destructive/20">
                  <AlertCircle className="h-5 w-5 flex-shrink-0" />
                  <div className="flex-1 text-sm">{storageError}</div>
                  <Button variant="outline" size="sm" onClick={loadStorageInfo}>
                    <RefreshCw className="h-3 w-3 mr-1" />
                    Retry
                  </Button>
                </div>
              )}
              {storageInfo && (
                <>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground">Total Size</p>
                      <p className="font-medium">{formatBytes(storageInfo.totalSizeBytes)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Recordings</p>
                      <p className="font-medium">{storageInfo.recordingsCount} files</p>
                    </div>
                  </div>

                  <div className="space-y-3 text-sm">
                    <div className="flex items-center justify-between p-2 bg-muted/50 rounded">
                      <div className="flex-1 min-w-0">
                        <p className="text-muted-foreground text-xs">Recordings</p>
                        <p className="font-mono text-xs truncate" title={storageInfo.recordingsPath}>
                          {storageInfo.recordingsPath}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => handleOpenFolder('recordings')}>
                        <FolderOpen className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="flex items-center justify-between p-2 bg-muted/50 rounded">
                      <div className="flex-1 min-w-0">
                        <p className="text-muted-foreground text-xs">Transcripts</p>
                        <p className="font-mono text-xs truncate" title={storageInfo.transcriptsPath}>
                          {storageInfo.transcriptsPath}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => handleOpenFolder('transcripts')}>
                        <FolderOpen className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="flex items-center justify-between p-2 bg-muted/50 rounded">
                      <div className="flex-1 min-w-0">
                        <p className="text-muted-foreground text-xs">Data</p>
                        <p className="font-mono text-xs truncate" title={storageInfo.dataPath}>
                          {storageInfo.dataPath}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => handleOpenFolder('data')}>
                        <FolderOpen className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="border-t pt-4 space-y-3">
                    <div>
                      <p className="font-medium">Portable backup</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Copies the database, recordings, transcript sidecars, speaker labels, and metadata with SHA-256
                        checksums. API keys are intentionally excluded.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" onClick={handleCreateBackup} disabled={backupBusy}>
                        {backupBusy ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <Archive className="h-4 w-4 mr-2" />}
                        Create Backup
                      </Button>
                      <Button variant="outline" onClick={handleValidateBackup} disabled={backupBusy}>
                        <ShieldCheck className="h-4 w-4 mr-2" />
                        Validate Backup
                      </Button>
                      <Button
                        variant="outline"
                        className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={handleRestoreBackup}
                        disabled={backupBusy}
                      >
                        <RotateCcw className="h-4 w-4 mr-2" />
                        Restore Backup
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Restore validates the selected backup, creates a safety copy of the current library, then restarts
                      HiDock Next to replace the database and files. API keys remain unchanged.
                    </p>
                  </div>

                  <div className="border-t pt-4 space-y-3">
                    <div>
                      <p className="font-medium">Otter migration</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Inspect an Otter ZIP export, recover source dates from filenames and summary content, identify
                        missing transcripts, find existing duplicates, and inventory reusable speaker labels.
                      </p>
                    </div>
                    <Button variant="outline" onClick={handlePreviewOtterImport} disabled={otterBusy || backupBusy}>
                      {otterBusy
                        ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                        : <FileArchive className="h-4 w-4 mr-2" />}
                      Inspect Otter Export
                    </Button>
                    {otterPreview && (
                      <div className="rounded-md border bg-muted/30 p-3 space-y-2 text-sm" role="status">
                        <p className="font-medium break-all">{otterPreview.archiveFilename}</p>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                          <span>Conversations</span><span className="font-medium">{otterPreview.counts.total}</span>
                          <span>Ready with exact time</span><span className="font-medium">{otterPreview.counts.ready}</span>
                          <span>Date review needed</span><span className="font-medium">{otterPreview.counts.dateReview}</span>
                          <span>Missing transcript</span><span className="font-medium">{otterPreview.counts.missingTranscript}</span>
                          <span>Existing/duplicate</span><span className="font-medium">{otterPreview.counts.duplicate}</span>
                          <span>Unique speaker labels</span><span className="font-medium">{otterPreview.counts.uniqueSpeakers}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Date-only conversations retain their calendar date with “time unknown” and are excluded from
                          automatic calendar matching. The ZIP/export timestamp is never used as the recording date.
                        </p>
                        <Button
                          variant="outline"
                          onClick={handleCommitOtterImport}
                          disabled={otterBusy || otterPreview.items.every((item) =>
                            item.status === 'duplicate' || item.sourceDatePrecision === 'unknown'
                          )}
                        >
                          <Archive className="h-4 w-4 mr-2" />
                          Import Non-Duplicates
                        </Button>
                      </div>
                    )}
                    <div className="border-t pt-3 space-y-2">
                      <p className="text-sm font-medium">Otter ↔ HiDock reconciliation</p>
                      <p className="text-xs text-muted-foreground">
                        Compare imported Otter conversations with the saved P1 inventory. This preview is read-only:
                        it does not merge, download, rename, or delete recordings.
                      </p>
                      <Button
                        variant="outline"
                        onClick={handlePreviewOtterReconciliation}
                        disabled={reconciliationBusy || otterBusy || backupBusy}
                      >
                        {reconciliationBusy
                          ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                          : <Link2 className="h-4 w-4 mr-2" />}
                        Preview HiDock Reconciliation
                      </Button>
                      {reconciliationPreview && (
                        <div
                          className="rounded-md border bg-muted/30 p-3 space-y-3 text-sm"
                          role="region"
                          aria-label="Otter reconciliation review"
                        >
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                            <span>Saved P1 recordings</span>
                            <span className="font-medium">{reconciliationPreview.counts.deviceRecordings}</span>
                            <span>Imported Otter conversations</span>
                            <span className="font-medium">{reconciliationPreview.counts.importedOtter}</span>
                            <span>Before first saved P1 recording</span>
                            <span className="font-medium">{reconciliationPreview.counts.preDeviceOtterOnly}</span>
                            <span>Exact timestamp matches</span>
                            <span className="font-medium">{reconciliationPreview.counts.exactTimestampMatches}</span>
                            <span>Date + duration matches</span>
                            <span className="font-medium">{reconciliationPreview.counts.dateDurationMatches}</span>
                            <span>Adjacent-day duration evidence</span>
                            <span className="font-medium">
                              {reconciliationPreview.counts.adjacentDateDurationMatches}
                            </span>
                            <span>Total proposed matches</span>
                            <span className="font-medium">{reconciliationPreview.counts.provisionalMatches}</span>
                            <span>Needs stronger evidence</span>
                            <span className="font-medium">{reconciliationPreview.counts.unresolvedOverlapping}</span>
                            <span>Missing transcript, usable audio</span>
                            <span className="font-medium">
                              {reconciliationPreview.counts.importedMissingTranscriptUsableAudio}
                            </span>
                            <span>Missing transcript, unusable/stub audio</span>
                            <span className="font-medium">
                              {reconciliationPreview.counts.importedMissingTranscriptUnusableAudio}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Proposed matches retain the HiDock recording and source timestamp as authoritative. A later
                            confirmed merge will attach Otter transcript metadata to that canonical recording.
                          </p>
                          <div className="grid grid-cols-3 gap-2 rounded border bg-background p-2 text-center text-xs">
                            <div><p className="font-semibold text-green-700 dark:text-green-400">{reconciliationSummary.confirmed}</p><p>Confirmed</p></div>
                            <div><p className="font-semibold">{reconciliationSummary.separate}</p><p>Keep separate</p></div>
                            <div><p className="font-semibold text-amber-700 dark:text-amber-400">{reconciliationSummary.pending}</p><p>Pending</p></div>
                          </div>
                          <div className="flex flex-wrap gap-2" role="group" aria-label="Reconciliation review category">
                            <Button
                              size="sm"
                              variant={reconciliationView === 'matches' ? 'default' : 'outline'}
                              onClick={() => { setReconciliationView('matches'); setReconciliationPage(0) }}
                            >
                              Proposed matches ({reconciliationPreview.matches.length})
                            </Button>
                            <Button
                              size="sm"
                              variant={reconciliationView === 'unresolved' ? 'default' : 'outline'}
                              onClick={() => { setReconciliationView('unresolved'); setReconciliationPage(0) }}
                            >
                              Unresolved ({reconciliationPreview.unresolved.length})
                            </Button>
                          </div>
                          <div className="grid gap-2 sm:grid-cols-2">
                            <Input
                              value={reconciliationSearch}
                              onChange={(event) => { setReconciliationSearch(event.target.value); setReconciliationPage(0) }}
                              placeholder="Search Otter or HiDock filename"
                              aria-label="Search reconciliation items"
                            />
                            {reconciliationView === 'matches' && (
                              <select
                                value={reconciliationMethod}
                                onChange={(event) => {
                                  setReconciliationMethod(event.target.value as ReconciliationMethod)
                                  setReconciliationPage(0)
                                }}
                                aria-label="Filter reconciliation evidence"
                                className="rounded-md border border-input bg-background px-3 py-2 text-sm"
                              >
                                <option value="all">All evidence</option>
                                <option value="exact-timestamp">Exact timestamp</option>
                                <option value="date-duration">Same date + duration</option>
                                <option value="adjacent-date-duration">Adjacent date + duration</option>
                              </select>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {reconciliationView === 'matches' ? (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => setReconciliationDecision(
                                    reconciliationPreview.matches
                                      .filter((item) => item.method === 'exact-timestamp')
                                      .map((item) => item.importedRecordingId),
                                    'confirmed'
                                  )}
                                >
                                  Confirm all exact timestamp matches
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => setReconciliationDecision(
                                    reconciliationReviewItems.map(({ item }) => item.importedRecordingId),
                                    'confirmed'
                                  )}
                                  disabled={reconciliationReviewItems.length === 0}
                                >
                                  Confirm filtered matches
                                </Button>
                              </>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setReconciliationDecision(
                                  reconciliationReviewItems.map(({ item }) => item.importedRecordingId),
                                  'separate'
                                )}
                                disabled={reconciliationReviewItems.length === 0}
                              >
                                Keep all filtered unresolved items separate
                              </Button>
                            )}
                          </div>
                          <div className="space-y-2">
                            {reconciliationVisibleItems.map(({ kind, item }) => {
                              const decision = reconciliationDraft[item.importedRecordingId] || 'pending'
                              return (
                                <div key={item.importedRecordingId} className="rounded border bg-background p-2 text-xs space-y-2">
                                  <div className="min-w-0">
                                    <p className="font-medium break-all">{item.importedFilename}</p>
                                    {kind === 'match' ? (
                                      <>
                                        <p className="break-all text-muted-foreground">HiDock: {item.deviceFilename}</p>
                                        <p className="text-muted-foreground">
                                          {item.method.replaceAll('-', ' ')} · {Math.round(item.confidence * 100)}% confidence
                                          {item.durationDifferenceSeconds !== undefined
                                            ? ` · ${item.durationDifferenceSeconds.toFixed(2)}s duration difference`
                                            : ''}
                                        </p>
                                      </>
                                    ) : (
                                      <p className="text-muted-foreground">
                                        {item.recordedDate} · no high-confidence P1 match
                                        {item.nearestCandidates[0]?.durationDifferenceSeconds !== null &&
                                         item.nearestCandidates[0]?.durationDifferenceSeconds !== undefined
                                          ? ` · nearest duration differs by ${item.nearestCandidates[0].durationDifferenceSeconds.toFixed(1)}s`
                                          : ''}
                                      </p>
                                    )}
                                  </div>
                                  <div className="flex flex-wrap gap-2" role="group" aria-label={`Review ${item.importedFilename}`}>
                                    {kind === 'match' && (
                                      <Button
                                        size="sm"
                                        variant={decision === 'confirmed' ? 'default' : 'outline'}
                                        onClick={() => setReconciliationDecision([item.importedRecordingId], 'confirmed')}
                                        aria-pressed={decision === 'confirmed'}
                                      >
                                        Confirm match
                                      </Button>
                                    )}
                                    <Button
                                      size="sm"
                                      variant={decision === 'separate' ? 'default' : 'outline'}
                                      onClick={() => setReconciliationDecision([item.importedRecordingId], 'separate')}
                                      aria-pressed={decision === 'separate'}
                                    >
                                      Keep separate
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant={decision === 'pending' ? 'secondary' : 'ghost'}
                                      onClick={() => setReconciliationDecision([item.importedRecordingId], 'pending')}
                                      aria-pressed={decision === 'pending'}
                                    >
                                      Pending
                                    </Button>
                                  </div>
                                </div>
                              )
                            })}
                            {reconciliationVisibleItems.length === 0 && (
                              <p className="py-4 text-center text-xs text-muted-foreground">No review items match this filter.</p>
                            )}
                          </div>
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span>
                              Page {Math.min(reconciliationPage + 1, reconciliationPageCount)} of {reconciliationPageCount}
                              {' · '}{reconciliationReviewItems.length} items
                            </span>
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setReconciliationPage((page) => Math.max(0, page - 1))}
                                disabled={reconciliationPage === 0}
                              >
                                Previous
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setReconciliationPage((page) => Math.min(reconciliationPageCount - 1, page + 1))}
                                disabled={reconciliationPage + 1 >= reconciliationPageCount}
                              >
                                Next
                              </Button>
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                            <Button
                              onClick={handleSaveReconciliationReviews}
                              disabled={!reconciliationDirty || reconciliationBusy}
                            >
                              <Save className="h-4 w-4 mr-2" />
                              Save Review Plan
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={() => setReconciliationDraft({ ...reconciliationSaved })}
                              disabled={!reconciliationDirty || reconciliationBusy}
                            >
                              Discard Unsaved Changes
                            </Button>
                            <p className="basis-full text-xs text-muted-foreground">
                              Saving records review decisions only. It does not merge or modify audio, transcripts,
                              titles, filenames, source dates, or speaker data.
                            </p>
                          </div>
                          <div className="space-y-3 rounded-md border border-blue-200 bg-blue-50/60 p-3 dark:border-blue-900 dark:bg-blue-950/20">
                            <div>
                              <p className="text-sm font-medium">Canonical merge dry run</p>
                              <p className="text-xs text-muted-foreground">
                                Accepts proposed matches unless you already saved Keep Separate, and classifies any
                                still-pending unresolved conversation separately. This
                                check is read-only and cannot apply the merge.
                              </p>
                            </div>
                            <Button
                              variant="outline"
                              onClick={handleCanonicalMergeDryRun}
                              disabled={reconciliationBusy || backupBusy || otterBusy}
                            >
                              <ShieldCheck className="h-4 w-4 mr-2" />
                              {reconciliationBusy ? 'Checking merge plan...' : 'Run Canonical Merge Dry Run'}
                            </Button>
                            {canonicalMergePlan && (
                              <div className="space-y-2 text-xs" aria-label="Canonical merge dry run result">
                                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                                  <div><p className="font-semibold">{canonicalMergePlan.counts.proposedAccepted}</p><p>Accepted matches</p></div>
                                  <div><p className="font-semibold">{canonicalMergePlan.counts.canonicalizeImported}</p><p>Canonicalize in place</p></div>
                                  <div><p className="font-semibold">{canonicalMergePlan.counts.consolidateExisting}</p><p>Existing HiDock rows</p></div>
                                  <div><p className="font-semibold">{canonicalMergePlan.counts.unresolvedKeptSeparate}</p><p>Keep separate</p></div>
                                  <div><p className="font-semibold">{canonicalMergePlan.counts.preDevicePreserved}</p><p>Pre-device preserved</p></div>
                                  <div>
                                    <p className={canonicalMergePlan.ready ? 'font-semibold text-green-700 dark:text-green-400' : 'font-semibold text-red-700 dark:text-red-400'}>
                                      {canonicalMergePlan.counts.blockers}
                                    </p>
                                    <p>Blockers</p>
                                  </div>
                                </div>
                                <p className="font-medium">
                                  {canonicalMergePlan.ready
                                    ? 'Ready for backup and explicit execution approval.'
                                    : 'Not ready to execute. Resolve every blocker and run the dry check again.'}
                                </p>
                                {canonicalMergePlan.blockers.length > 0 && (
                                  <ul className="list-disc space-y-1 pl-5 text-red-700 dark:text-red-400">
                                    {canonicalMergePlan.blockers.slice(0, 10).map((blocker) => <li key={blocker}>{blocker}</li>)}
                                  </ul>
                                )}
                                <p className="text-muted-foreground">Plan fingerprint: {canonicalMergePlan.fingerprint.slice(0, 16)}…</p>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Health Check & Advanced Operations */}
          <HealthCheck />
        </div>
      </div>
    </div>
  )
}

export default Settings
