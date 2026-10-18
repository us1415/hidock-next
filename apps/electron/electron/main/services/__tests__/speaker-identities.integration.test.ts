/**
 * @vitest-environment node
 */

import { existsSync, mkdirSync, rmSync } from 'fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => {
  const root = `${process.env.TEMP || process.env.TMP || '.'}\\hidock-speakers-${process.pid}-${Date.now()}`
  return { root, databasePath: `${root}\\library.db` }
})

vi.mock('../file-storage', () => ({
  getDatabasePath: () => testState.databasePath
}))

import * as database from '../database'
import {
  assignSpeakerAlias,
  confirmAllSpeakerIdentities,
  getConfirmedSpeakerNameHints,
  mergeSpeakerIdentities,
  rebuildSpeakerIndex,
  renameSpeakerIdentity,
  setPrioritySpeakerIdentity,
  setSelfSpeakerIdentity
} from '../speaker-identities'
import { extractSpeakerReferenceCandidates, selectKnownSpeakerIdentityIds } from '../speaker-references'

describe('speaker identity evidence index', () => {
  beforeAll(async () => {
    mkdirSync(testState.root, { recursive: true })
    await database.initializeDatabase()

    for (const [id, date] of [['recording-one', '2026-01-01T15:00:00.000Z'], ['recording-two', '2026-02-01T15:00:00.000Z']]) {
      database.insertRecording({
        id,
        filename: `${id}.mp3`,
        original_filename: `${id}.mp3`,
        file_path: `${testState.root}\\${id}.mp3`,
        file_size: 100,
        duration_seconds: 60,
        date_recorded: date,
        source_date_precision: 'exact',
        source_date_evidence: 'otter-export',
        status: 'complete',
        location: 'local-only',
        transcription_status: 'complete',
        on_device: 0,
        on_local: 1,
        source: 'import',
        is_imported: 1
      })
    }

    database.run(
      'INSERT INTO transcripts (id, recording_id, full_text, speakers) VALUES (?, ?, ?, ?)',
      ['transcript-one', 'recording-one', 'Joel K  00:00\nHello\nSpeaker 1  00:10\nHi', JSON.stringify(['Joel K', 'Speaker 1'])]
    )
    database.run(
      'INSERT INTO transcripts (id, recording_id, full_text, speakers) VALUES (?, ?, ?, ?)',
      ['transcript-two', 'recording-two', 'joel k.  00:00\nHello\nJoey A  00:10\nHi', JSON.stringify(['joel k.', 'Joey A'])]
    )
  })

  afterAll(() => {
    database.closeDatabase()
    if (existsSync(testState.root)) rmSync(testState.root, { recursive: true, force: true })
  })

  it('preserves raw labels, supports corrections, and keeps decisions across rebuilds', () => {
    let overview = rebuildSpeakerIndex('2026-10-18T12:00:00.000Z')

    expect(overview.counts).toMatchObject({ identities: 2, rawLabels: 4, unresolvedAliases: 1 })
    expect(overview.identities.find((identity) => identity.displayName === 'Joel K')?.aliases.map((alias) => alias.rawLabel).sort())
      .toEqual(['Joel K', 'joel k.'])

    overview = confirmAllSpeakerIdentities('2026-10-18T12:00:30.000Z')
    expect(overview.counts).toMatchObject({ confirmed: 2, needsReview: 0 })
    expect(getConfirmedSpeakerNameHints()).toEqual(['Joel K', 'Joey A'])

    const joel = overview.identities.find((identity) => identity.displayName === 'Joel K')!
    expect(setSelfSpeakerIdentity(joel.id, '2026-10-18T12:00:45.000Z')).toMatchObject({ isSelf: true })
    const joeyBeforeMerge = overview.identities.find((identity) => identity.displayName === 'Joey A')!
    expect(setPrioritySpeakerIdentity(joeyBeforeMerge.id, true, '2026-10-18T12:00:46.000Z'))
      .toMatchObject({ isPriority: true })
    expect(selectKnownSpeakerIdentityIds([])).toEqual([joel.id, joeyBeforeMerge.id])
    expect(extractSpeakerReferenceCandidates('Joel K  00:00\nHello\nSpeaker 1  00:10\nHi', 'Joel K'))
      .toEqual([{ startSeconds: 0.25, endSeconds: 8.25, durationSeconds: 8 }])
    expect(selectKnownSpeakerIdentityIds([{ organizer_name: 'Joey A' }])).toEqual([
      joel.id,
      overview.identities.find((identity) => identity.displayName === 'Joey A')!.id
    ])
    renameSpeakerIdentity(joel.id, 'Joel Khan', '2026-10-18T12:01:00.000Z')
    overview = rebuildSpeakerIndex('2026-10-18T12:02:00.000Z')
    expect(overview.identities.find((identity) => identity.id === joel.id)).toMatchObject({
      displayName: 'Joel Khan',
      status: 'confirmed',
      isSelf: true,
      isPriority: false
    })

    const unresolved = overview.unresolvedAliases[0]
    expect(() => assignSpeakerAlias(unresolved.id, joel.id, '2026-10-18T12:03:00.000Z'))
      .toThrow('Generic labels vary by recording')
    const joey = overview.identities.find((identity) => identity.displayName === 'Joey A')!
    mergeSpeakerIdentities(joey.id, joel.id, '2026-10-18T12:04:00.000Z')

    overview = rebuildSpeakerIndex('2026-10-18T12:05:00.000Z')
    expect(overview.counts).toMatchObject({ identities: 1, rawLabels: 4, unresolvedAliases: 1, confirmed: 1 })
    expect(overview.identities[0].aliases.map((alias) => alias.rawLabel).sort())
      .toEqual(['Joel K', 'Joey A', 'joel k.'])
    expect(overview.identities[0]).toMatchObject({
      displayName: 'Joel Khan',
      isPriority: true,
      firstSeenAt: '2026-01-01T15:00:00.000Z',
      lastSeenAt: '2026-02-01T15:00:00.000Z'
    })
  })
})
