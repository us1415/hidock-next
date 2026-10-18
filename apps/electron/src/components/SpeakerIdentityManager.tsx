import { useCallback, useEffect, useMemo, useState } from 'react'
import { Combine, RefreshCw, Save, UserRoundCheck } from 'lucide-react'
import type { SpeakerIdentity, SpeakerOverview } from '../../electron/preload'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { toast } from '@/components/ui/toaster'

interface MergeRequest {
  source: SpeakerIdentity
  target: SpeakerIdentity
}

function errorMessage(result: { success: boolean; error?: { message?: string } }, fallback: string): string {
  return result.error?.message || fallback
}

export function SpeakerIdentityManager() {
  const [overview, setOverview] = useState<SpeakerOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [names, setNames] = useState<Record<string, string>>({})
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({})
  const [mergeRequest, setMergeRequest] = useState<MergeRequest | null>(null)
  const [confirmAllOpen, setConfirmAllOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.speakers.getOverview()
      if (!result.success) throw new Error(errorMessage(result, 'Unable to load speaker labels'))
      setOverview(result.data)
      setNames(Object.fromEntries(result.data.identities.map((identity) => [identity.id, identity.displayName])))
    } catch (cause) {
      toast.error('Speaker labels unavailable', cause instanceof Error ? cause.message : 'Unexpected error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const identities = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    if (!query || !overview) return overview?.identities || []
    return overview.identities.filter((identity) =>
      identity.displayName.toLocaleLowerCase().includes(query) ||
      identity.aliases.some((alias) => alias.rawLabel.toLocaleLowerCase().includes(query))
    )
  }, [overview, search])

  const rebuild = async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.speakers.rebuild()
      if (!result.success) throw new Error(errorMessage(result, 'Unable to normalize speaker labels'))
      setOverview(result.data)
      setNames(Object.fromEntries(result.data.identities.map((identity) => [identity.id, identity.displayName])))
      toast.success('Speaker history indexed', `${result.data.counts.rawLabels} original labels were preserved`)
    } catch (cause) {
      toast.error('Indexing failed', cause instanceof Error ? cause.message : 'Unexpected error')
    } finally {
      setLoading(false)
    }
  }

  const confirmAll = async () => {
    const result = await window.electronAPI.speakers.confirmAll()
    if (!result.success) {
      toast.error('Speakers not confirmed', errorMessage(result, 'Unable to confirm speaker identities'))
    } else {
      setOverview(result.data)
      toast.success('Named speakers confirmed', `${result.data.counts.confirmed} identities are now confirmed`)
    }
    setConfirmAllOpen(false)
  }

  const saveName = async (identity: SpeakerIdentity) => {
    const displayName = names[identity.id]?.trim()
    if (!displayName || displayName === identity.displayName) return
    const result = await window.electronAPI.speakers.renameIdentity({ identityId: identity.id, displayName })
    if (!result.success) {
      toast.error('Name not saved', errorMessage(result, 'Unable to rename speaker'))
      return
    }
    toast.success('Speaker confirmed', displayName)
    await load()
  }

  const requestMerge = (source: SpeakerIdentity) => {
    const target = overview?.identities.find((identity) => identity.id === mergeTargets[source.id])
    if (target) setMergeRequest({ source, target })
  }

  const confirmMerge = async () => {
    if (!mergeRequest) return
    const result = await window.electronAPI.speakers.mergeIdentities({
      sourceId: mergeRequest.source.id,
      targetId: mergeRequest.target.id
    })
    if (!result.success) {
      toast.error('Speakers not merged', errorMessage(result, 'Unable to merge speakers'))
    } else {
      toast.success('Speakers merged', `${mergeRequest.source.displayName} is now ${mergeRequest.target.displayName}`)
      await load()
    }
    setMergeRequest(null)
  }

  return (
    <>
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <UserRoundCheck className="h-5 w-5" /> Transcript speaker identities
              </CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Original transcript labels remain unchanged. Corrections here become reusable identity evidence.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={rebuild} disabled={loading}>
              <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Normalize transcript history
            </Button>
            {!!overview?.counts.needsReview && (
              <Button size="sm" onClick={() => setConfirmAllOpen(true)} disabled={loading}>
                <UserRoundCheck className="mr-2 h-4 w-4" /> Confirm all named
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {overview && (
            <div className="mb-4 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
              {[
                ['Identities', overview.counts.identities],
                ['Confirmed', overview.counts.confirmed],
                ['Original labels', overview.counts.rawLabels],
                ['Unresolved', overview.counts.unresolvedAliases]
              ].map(([label, value]) => (
                <div key={label} className="rounded-md border bg-muted/30 p-2">
                  <div className="text-lg font-semibold">{value}</div>
                  <div className="text-xs text-muted-foreground">{label}</div>
                </div>
              ))}
            </div>
          )}

          <Input
            className="mb-4 max-w-sm"
            placeholder="Find a speaker or original label..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />

          {loading && !overview ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Loading speaker history…</div>
          ) : identities.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              No indexed speaker labels yet. Normalize transcript history to build the first index.
            </div>
          ) : (
            <div className="max-h-[520px] space-y-3 overflow-auto pr-1">
              {identities.map((identity) => (
                <div key={identity.id} className="rounded-md border p-3">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                    <div className="flex min-w-0 flex-1 gap-2">
                      <Input
                        aria-label={`Name for ${identity.displayName}`}
                        value={names[identity.id] ?? identity.displayName}
                        onChange={(event) => setNames((current) => ({ ...current, [identity.id]: event.target.value }))}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!names[identity.id]?.trim() || names[identity.id]?.trim() === identity.displayName}
                        onClick={() => saveName(identity)}
                      >
                        <Save className="mr-2 h-4 w-4" /> Save
                      </Button>
                    </div>
                    <div className="flex min-w-0 flex-1 gap-2">
                      <select
                        className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm"
                        aria-label={`Merge ${identity.displayName} into`}
                        value={mergeTargets[identity.id] || ''}
                        onChange={(event) => setMergeTargets((current) => ({ ...current, [identity.id]: event.target.value }))}
                      >
                        <option value="">Merge into…</option>
                        {overview?.identities.filter((candidate) => candidate.id !== identity.id).map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>{candidate.displayName}</option>
                        ))}
                      </select>
                      <Button size="sm" variant="outline" disabled={!mergeTargets[identity.id]} onClick={() => requestMerge(identity)}>
                        <Combine className="mr-2 h-4 w-4" /> Merge
                      </Button>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                    <span className={identity.status === 'confirmed' ? 'text-emerald-600' : 'text-amber-600'}>
                      {identity.status === 'confirmed' ? 'Confirmed' : 'Needs review'}
                    </span>
                    <span className="text-muted-foreground">• {identity.occurrenceCount} transcripts •</span>
                    {identity.aliases.map((alias) => (
                      <span key={alias.id} className="rounded bg-muted px-2 py-0.5" title="Original transcript label">
                        {alias.rawLabel}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {!!overview?.unresolvedAliases.length && (
            <div className="mt-5 border-t pt-4">
              <h3 className="mb-1 text-sm font-semibold">Unresolved generic labels</h3>
              <p className="mb-3 text-xs text-muted-foreground">
                These stay unresolved because labels such as “Speaker 1” refer to different people in different recordings.
                They will be resolved per recording in the recognition phase, never globally.
              </p>
              <div className="space-y-2">
                {overview.unresolvedAliases.map((alias) => (
                  <div key={alias.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
                    <span className="min-w-24 font-medium">{alias.rawLabel}</span>
                    <span className="text-xs text-muted-foreground">{alias.occurrenceCount} transcripts</span>
                    <span className="ml-auto text-xs text-muted-foreground">Per-recording review required</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={!!mergeRequest} onOpenChange={(open) => !open && setMergeRequest(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge speaker identities?</AlertDialogTitle>
            <AlertDialogDescription>
              All original labels for “{mergeRequest?.source.displayName}” will be assigned to
              “{mergeRequest?.target.displayName}”. The raw transcript text will remain unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmMerge}>Merge identities</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmAllOpen} onOpenChange={setConfirmAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm all named speakers?</AlertDialogTitle>
            <AlertDialogDescription>
              This marks all {overview?.counts.needsReview || 0} named identities as trusted Otter labels.
              Generic labels such as “Speaker 1” will remain unresolved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmAll}>Confirm named speakers</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
