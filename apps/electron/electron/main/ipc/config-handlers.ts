import { ipcMain } from 'electron'
import {
  getConfig,
  getPublicConfig,
  saveConfig,
  updateConfig,
  AppConfig,
  SENSITIVE_CONFIG_MASK
} from '../services/config'
import { success, error as errorResult } from '../types/api'
import { emitActivityLog } from '../services/activity-log'

export function registerConfigHandlers(): void {
  // Get full config
  ipcMain.handle('config:get', async () => {
    try {
      return success(getPublicConfig())
    } catch (err) {
      console.error('[config:get] Error:', err)
      return errorResult(
        'SERVICE_UNAVAILABLE',
        err instanceof Error ? err.message : 'Failed to load configuration',
        err
      )
    }
  })

  // Save full config
  ipcMain.handle('config:set', async (_, newConfig: Partial<AppConfig>) => {
    try {
      const sanitizedConfig = { ...newConfig }
      if (sanitizedConfig.transcription) {
        sanitizedConfig.transcription = sanitizeTranscriptionSecrets(
          sanitizedConfig.transcription
        ) as AppConfig['transcription']
      }
      await saveConfig(sanitizedConfig)
      emitActivityLog('info', 'Settings saved')
      return success(getPublicConfig())
    } catch (err) {
      console.error('[config:set] Error:', err)
      emitActivityLog('error', 'Failed to save settings', err instanceof Error ? err.message : undefined)
      return errorResult(
        'VALIDATION_ERROR',
        err instanceof Error ? err.message : 'Failed to save configuration',
        err
      )
    }
  })

  // Update a specific section
  ipcMain.handle(
    'config:update-section',
    async <K extends keyof AppConfig>(_, section: K, values: Partial<AppConfig[K]>) => {
      try {
        const sanitizedValues = section === 'transcription'
          ? sanitizeTranscriptionSecrets(values as Partial<AppConfig['transcription']>)
          : values
        await updateConfig(section, sanitizedValues as Partial<AppConfig[K]>)
        emitActivityLog('info', `Settings updated: ${String(section)}`)
        return success(getPublicConfig())
      } catch (err) {
        console.error(`[config:update-section] Error updating ${String(section)}:`, err)
        emitActivityLog('error', `Failed to update ${String(section)} settings`, err instanceof Error ? err.message : undefined)
        return errorResult(
          'VALIDATION_ERROR',
          err instanceof Error ? err.message : `Failed to update ${String(section)} settings`,
          err
        )
      }
    }
  )

  // Get specific value
  ipcMain.handle('config:get-value', async (_, key: string) => {
    try {
      const config = getConfig()
      const value = key.split('.').reduce<unknown>((current, segment) => {
        if (!current || typeof current !== 'object') return undefined
        return (current as Record<string, unknown>)[segment]
      }, config)
      const isSecret = key === 'transcription.geminiApiKey' || key === 'transcription.openaiApiKey'
      return success(isSecret && value ? SENSITIVE_CONFIG_MASK : value)
    } catch (err) {
      console.error(`[config:get-value] Error getting ${String(key)}:`, err)
      return errorResult(
        'SERVICE_UNAVAILABLE',
        err instanceof Error ? err.message : `Failed to get ${String(key)} value`,
        err
      )
    }
  })
}

function sanitizeTranscriptionSecrets(
  values: Partial<AppConfig['transcription']>
): Partial<AppConfig['transcription']> {
  const sanitized = { ...values }
  if (sanitized.geminiApiKey === SENSITIVE_CONFIG_MASK) delete sanitized.geminiApiKey
  if (sanitized.openaiApiKey === SENSITIVE_CONFIG_MASK) delete sanitized.openaiApiKey
  return sanitized
}
