import { ipcMain } from 'electron'
import { error, Result, success } from '../types/api'
import {
  assignSpeakerAlias,
  confirmAllSpeakerIdentities,
  getSpeakerOverview,
  mergeSpeakerIdentities,
  rebuildSpeakerIndex,
  renameSpeakerIdentity,
  setPrioritySpeakerIdentity,
  setSelfSpeakerIdentity,
  SpeakerIdentity,
  SpeakerOverview
} from '../services/speaker-identities'
import { createKnownSpeakerReferences } from '../services/speaker-references'

interface IdentityNameRequest { identityId: string; displayName: string }
interface IdentityMergeRequest { sourceId: string; targetId: string }
interface AliasAssignmentRequest { aliasId: string; identityId: string }

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128
}

function failure(message: string, cause?: unknown): Result<never> {
  return error('DATABASE_ERROR', message, cause)
}

export function registerSpeakerHandlers(): void {
  ipcMain.handle('speakers:getOverview', async (): Promise<Result<SpeakerOverview>> => {
    try {
      return success(getSpeakerOverview())
    } catch (cause) {
      return failure('Failed to load speaker identities', cause)
    }
  })

  ipcMain.handle('speakers:rebuild', async (): Promise<Result<SpeakerOverview>> => {
    try {
      return success(rebuildSpeakerIndex())
    } catch (cause) {
      return failure('Failed to normalize transcript speaker labels', cause)
    }
  })

  ipcMain.handle('speakers:confirmAll', async (): Promise<Result<SpeakerOverview>> => {
    try {
      return success(confirmAllSpeakerIdentities())
    } catch (cause) {
      return failure('Failed to confirm speaker identities', cause)
    }
  })

  ipcMain.handle('speakers:setSelf', async (_, identityId: unknown): Promise<Result<SpeakerIdentity>> => {
    if (!validId(identityId)) return error('VALIDATION_ERROR', 'A valid speaker identity is required')
    try {
      return success(setSelfSpeakerIdentity(identityId))
    } catch (cause) {
      return failure(cause instanceof Error ? cause.message : 'Failed to set your speaker identity', cause)
    }
  })

  ipcMain.handle('speakers:setPriority', async (_, request: { identityId?: unknown; isPriority?: unknown }): Promise<Result<SpeakerIdentity>> => {
    if (!validId(request?.identityId) || typeof request?.isPriority !== 'boolean') {
      return error('VALIDATION_ERROR', 'A valid speaker identity and priority are required')
    }
    try {
      return success(setPrioritySpeakerIdentity(request.identityId, request.isPriority))
    } catch (cause) {
      return failure(cause instanceof Error ? cause.message : 'Failed to prioritize speaker identity', cause)
    }
  })

  ipcMain.handle('speakers:prepareReference', async (_, identityId: unknown): Promise<Result<{
    available: boolean
    name?: string
    audioBytes?: number
  }>> => {
    if (!validId(identityId)) return error('VALIDATION_ERROR', 'A valid speaker identity is required')
    try {
      const reference = (await createKnownSpeakerReferences([identityId]))[0]
      if (!reference) return success({ available: false })
      const encoded = reference.dataUrl.slice(reference.dataUrl.indexOf(',') + 1)
      return success({ available: true, name: reference.name, audioBytes: Buffer.from(encoded, 'base64').byteLength })
    } catch (cause) {
      return failure(cause instanceof Error ? cause.message : 'Failed to prepare a speaker reference', cause)
    }
  })

  ipcMain.handle('speakers:renameIdentity', async (_, request: IdentityNameRequest): Promise<Result<SpeakerIdentity>> => {
    if (!validId(request?.identityId) || typeof request?.displayName !== 'string' ||
        request.displayName.trim().length < 1 || request.displayName.trim().length > 200) {
      return error('VALIDATION_ERROR', 'A valid speaker and name are required')
    }
    try {
      return success(renameSpeakerIdentity(request.identityId, request.displayName))
    } catch (cause) {
      return failure(cause instanceof Error ? cause.message : 'Failed to rename speaker identity', cause)
    }
  })

  ipcMain.handle('speakers:mergeIdentities', async (_, request: IdentityMergeRequest): Promise<Result<SpeakerIdentity>> => {
    if (!validId(request?.sourceId) || !validId(request?.targetId)) {
      return error('VALIDATION_ERROR', 'Two valid speaker identities are required')
    }
    try {
      return success(mergeSpeakerIdentities(request.sourceId, request.targetId))
    } catch (cause) {
      return failure(cause instanceof Error ? cause.message : 'Failed to merge speaker identities', cause)
    }
  })

  ipcMain.handle('speakers:assignAlias', async (_, request: AliasAssignmentRequest): Promise<Result<SpeakerIdentity>> => {
    if (!validId(request?.aliasId) || !validId(request?.identityId)) {
      return error('VALIDATION_ERROR', 'A valid label and speaker identity are required')
    }
    try {
      return success(assignSpeakerAlias(request.aliasId, request.identityId))
    } catch (cause) {
      return failure(cause instanceof Error ? cause.message : 'Failed to assign speaker label', cause)
    }
  })
}
