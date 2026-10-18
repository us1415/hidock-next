# P1 Transcription Automation Roadmap and Bug Tracker

Last updated: 2026-10-18

## Product objective

Replace the manual P1 workflow—work computer to phone to Otter—with a reliable local-first flow:

1. Detect new recordings on the connected HiDock P1.
2. Download only recordings the user has selected or explicitly opted into syncing.
3. Preserve the device's original recording timestamp and raw audio.
4. Transcribe through the configured provider, currently OpenAI.
5. Store, search, rename, export, and back up transcripts without changing their source dates.
6. Learn reusable speaker identities from corrected historical and future transcripts.

## Safety rules

- Automatic device download and paid transcription remain off by default.
- Never use the broad `Process All` path during development verification.
- Preserve raw recordings and original device timestamps.
- Treat `recordings.date_recorded` as the authoritative source date everywhere. `created_at`, upload time,
  download time, transcription time, and export time are audit metadata only and must never silently replace it.
- If a trustworthy source date cannot be determined, keep it unknown and require review; never substitute the current time.
- Never record API-key values in logs, documentation, or tests.
- Test with one explicitly selected recording before enabling any automation rule.

## Current count

- Discovered: 37
- Fixed and verified: 35
- Fixed, device verification pending: 1
- Open: 1

## Bugs

| ID | Status | Bug | Evidence / resolution |
| --- | --- | --- | --- |
| TR-001 | Fixed and verified | Connecting a P1 could automatically queue every device recording for download and transcription. | Auto-download and auto-transcribe now default off, older configuration is migrated to safe defaults, and automatic bulk sync is capped at 20 files. |
| TR-002 | Fixed and verified | HiDock `.hda` MP3 bytes were saved with a `.wav` extension, causing OpenAI to reject the audio format. | Device downloads are saved as `.mp3`; legacy mislabeled files are identified by magic bytes before upload. |
| TR-003 | Fixed and verified | A large persisted download/transcription queue could resume after restart. | Oversized persisted queues are paused and stale non-retryable transcription failures are not revived. |
| TR-004 | Fixed and verified | Fresh database initialization could fail while parsing SQL comments. | Schema initialization/comment handling was corrected and the app starts cleanly with a new database. |
| TR-005 | Fixed and verified | Transcribing immediately after a device download could enqueue `synced_files.id` instead of canonical `recordings.id`, failing before upload. | Queueing now resolves temporary synced-file IDs through the local path/filename to canonical recording IDs. Live verification completed with `2026Oct16-102913-Rec21.mp3`: OpenAI returned a 4,041-word transcript and the queue completed on the first attempt. |
| TR-006 | Fixed; device verification pending | P1 duration metadata was four times the decoded MP3 duration. | Version 5 files are P1 96 kbps MP3, or 12,000 bytes/second. The legacy extra 4x multiplier was removed. Unit checks now produce 12 seconds for the short sample and 2,047 seconds for the 34-minute sample; confirm once the P1 is connected and its file list is refreshed. |
| TR-007 | Fixed and verified | The packaged Ollama service tried to load `./config` dynamically and failed after bundling. | Replaced the runtime `require('./config')` with a bundle-safe static import. Production build succeeds and live startup now initializes Ollama from the configured URL/models without a module-resolution error. |
| TR-008 | Fixed and verified | When Ollama was unavailable, transcript indexing retried and logged a connection failure for every chunk. | Transcript indexing now performs one Ollama availability check and emits one concise warning before skipping the job. An automated test verifies one check, no embedding calls, and one warning. |
| TR-009 | Fixed and verified | The Electron project-wide TypeScript check was not clean, which weakened its value as a regression gate. | Corrected stale test imports, IPC/result contracts, contact/project nullability, SQL parameter types, preload declarations, WebUSB selection typing, and unused declarations. The full node-and-web `npm run typecheck` now passes. |
| TR-010 | Fixed and verified | Legacy recordings use IDs such as `rec_...`, but IPC validation accepted UUIDs only, preventing history and transcript export for those recordings. | Recording ID validation now accepts either a UUID or the constrained legacy `rec_` format. Live verification shows the existing OpenAI attempt in the selected recording's processing history. |
| TR-011 | Fixed and verified | Local-only Library rows could show transcription “Pending” even when a completed transcript and summary existed. | Local-only aggregation now prefers the authoritative `transcription_status` field, matching the already-correct device/local merged path. A regression test reproduces the real database state (`status: pending`, `transcription_status: complete`) and verifies that the Library maps it to Complete. |
| TR-012 | Fixed and verified | The unified Library hook emitted extensive development diagnostics even when QA Logs were disabled. | Informational and non-fatal diagnostic output now uses the shared QA toggle and consistent `[QA-MONITOR][Library]` prefix. A regression test verifies that diagnostics remain silent while QA Logs are disabled; operational errors remain visible. |
| TR-013 | Fixed and verified | The source list could show an AI-generated transcript title while the selected reader header showed the raw filename for the same recording. | The reader now uses the same smart-title priority chain as the list (meeting, saved title, transcript title, summary, filename), while preserving the original filename as secondary metadata. A focused UI regression test covers the reported P1 presentation. |
| TR-014 | Fixed and verified | Card view still used a simpler title fallback than compact-list and reader views, allowing the same inconsistency outside the reported view. | Card view now uses the shared smart-title resolver as well, so every Library presentation uses one title priority chain. |
| TR-015 | Fixed and verified | Newly detected recordings could be filtered into Review but could not be explicitly marked reviewed without downloading them, and dismissed state was lost after the next inventory observation. | The reader now offers reversible **Mark Reviewed** and **Add to Review** controls. Updating review status changes only local queue metadata; it does not download, transcribe, or delete the recording. Inventory refresh now preserves dismissed and approved states. |
| TR-016 | Fixed and verified | Opt-in auto-download still reconciled every unsynced device file, so a small historical archive could be downloaded even though the per-device baseline intentionally excluded it from Review. | Both ready-event and pre-connected auto-sync paths now observe the durable per-device inventory and intersect downloads with `status=new` Review items. The first scan downloads zero files, dismissed/baseline items are excluded, and the 20-file safety cap remains enforced. |
| TR-017 | Fixed and verified | Auto-transcription could be enabled without showing its paid nature or an estimate, and auto-download did not explain the first-scan baseline. | Enabling either automation now requires an explicit confirmation. The Device and Settings pages show model-specific audio estimates; `gpt-transcribe` is shown at $0.0045/minute (about $0.14/30 minutes or $0.27/hour) and separately discloses variable transcript-analysis charges. Rates were checked against the [official OpenAI pricing documentation](https://developers.openai.com/api/docs/pricing) on 2026-10-18. |
| TR-018 | Fixed and verified | Device-page automation toggles wrote configuration to disk without updating the shared renderer config store, so the auto-sync guard could continue using the old value until restart. | Device toggles now use the shared config store's transactional update path, keeping persisted configuration, the guard, and visible switch state synchronized immediately. |
| TR-019 | Fixed and verified | The assistant IPC test suite crashed during module setup because its Electron mock did not provide `app.getPath`, so the full regression gate could not execute every test. | The mock now includes the minimum `app.getPath` contract used by the imported service. The assistant handler test executes and passes in the full suite. |
| TR-020 | Fixed and verified | Library wall-clock performance tests intermittently failed in the full suite while passing alone because multiple jsdom files competed for the same CPU. | Vitest now runs test files serially, preserving meaningful per-test performance budgets. The default full gate passes all 1,429 tests, including the Library performance and accessibility suites. |
| TR-021 | Fixed and verified | Transcript analysis could replace a manually linked meeting, accept an invented meeting ID, or automatically link a low-confidence choice. | Calendar candidates are derived exclusively from the original `date_recorded` timestamp. Automatic linking now requires a candidate returned by that window and at least 0.75 confidence; manual links, explicit standalone decisions, and different existing links are never overwritten. Invalid source timestamps do not fall back to upload time. |
| TR-022 | Fixed and verified | Persisted failed downloads and transcriptions disappeared from retry controls after restart, and cancelling an active OpenAI transcription did not abort its request. | Queue hydration now restores failed/cancelled downloads and failed transcriptions with errors, progress, attempts, and retry counts. Completed history stays out of the active panel. Active OpenAI requests receive an abort signal; cancellation records a cancelled history entry, restores recording state, and cannot become a retryable failure. |
| TR-023 | Fixed and verified | Local semantic-search indexing timestamped transcript chunks with `recording.created_at` (ingestion time) instead of the authoritative `recording.date_recorded`. | Vector metadata now always uses `recording.date_recorded`. A regression test gives the recording different source and ingestion dates and verifies that indexing retains the source chronology. |
| TR-024 | Fixed and verified | Integrity repair could suggest `created_at` as the replacement for an invalid or suspicious recording date. | Suspicious source dates are now manual-review findings and are never auto-repaired from upload time or the current time. Focused tests cover invalid, implausibly old, and future dates. |
| TR-025 | Fixed and verified | Some Library/device-ingestion fallbacks used the current time when filename and device dates were unavailable. | Source dates are nullable from P1 discovery through the review queue and renderer. Unknown dates display explicitly, sort last, cannot drive calendar correlation, and are blocked from manual/automatic download until reviewed. Schema v23 safely migrates existing review data while permitting unknown dates. |
| TR-026 | Fixed and verified | Long transcript exports could split a speaker paragraph across pages, leaving continuation text without its speaker at the top of the next PDF page. | Transcript text is now rendered as escaped paragraph elements with print-safe page-break behavior. A six-page Electron render was visually inspected page by page; paragraphs, metadata, wrapping, source date, and numbered footers are clean. |
| TR-027 | Open | The Electron `npm run lint` command invokes ESLint 9, but the project has no `eslint.config.js/mjs/cjs`, so linting stops before checking any source file. | Reproduced while verifying portable restore. Add a flat ESLint configuration compatible with the installed Electron/TypeScript/React packages, then run and triage the actual lint findings separately from this restore change. |
| TR-028 | Fixed and verified | The shared `insertRecording` function discarded lifecycle fields supplied by external-file imports, allowing database defaults to misclassify imported local audio as on-device HiDock content. | Recording insertion now persists location, transcription status, device/local presence, source, imported state, storage tier, and device-last-seen metadata. A database regression test verifies the complete imported-record parameter set. |
| TR-029 | Fixed and verified | The device-save IPC path still replaced an unrecoverable source date with the current time, which could silently make a newly downloaded old recording appear to have happened today. | Device saves now require either the device timestamp or a timestamp recoverable from the HiDock filename. The app records that evidence explicitly and refuses the download when neither exists, instead of inventing chronology. |
| TR-030 | Fixed and verified | During the first real Otter import, the live recording watcher claimed the first collision-safe audio file before the import transaction committed, creating one extra database row with the import-time timestamp. | The commit handler now pauses and reliably restarts the watcher around the transactional file move. Watcher reconciliation also matches by physical `file_path`, which is required because imported records retain a different human-readable source filename. The single verified race row was removed after making a recoverable post-import database copy; the imported record and shared audio file were preserved. A clean restart scanned all 651 files without adding a row. |
| TR-031 | Fixed and verified | Integrity startup treated digit sequences inside collision-safe Otter physical filenames as HiDock timestamps, producing seven false ancient dates and attempted timestamp repairs. | HiDock filename parsing is now start-anchored, format-bounded, and calendar-validated. Imported collision-safe names and numeric titles are explicitly covered by regression tests. A clean restart reports 0 wrong-date files and 0 integrity issues. |
| TR-032 | Fixed and verified | Otter items without transcripts were counted as if they could simply be sent for transcription, even when the exported MP3 was only an ID3 stub or contained less than five seconds of audio. | The reconciliation preview now probes missing-transcript audio and separates usable audio from unusable/stub audio. All three real missing-transcript exports are pre-P1 items and unusable: 5,661 bytes/1.872 seconds, 8,145 bytes/2.7 seconds, and a 45-byte invalid MP3. The app no longer presents them as actionable paid-transcription candidates. |
| TR-033 | Fixed and verified | A brief Windows antivirus/indexer lock could make the final atomic backup-folder rename fail with `EPERM`, even after every file and checksum had been written successfully. | Portable backup creation and pending-restore marker creation now retry only transient Windows rename errors (`EPERM`, `EACCES`, and `EBUSY`) with a bounded 25/50/100/200 ms backoff. Permanent errors still fail immediately. Two deterministic retry-policy regressions were added; the complete portable-backup suite passes 9 tests. |
| TR-034 | Fixed and verified | A naive canonical merge would have collided with six existing local HiDock rows that use the same device basename with a `.wav` extension, risking duplicate Library items or lost Otter metadata. | The canonical planner now compares extension-independent device identities. It consolidates those six pairs into the existing HiDock rows, transfers their Otter transcript/history metadata, archives the redundant imported audio, and blocks execution if either side has conflicting transcript, capture, or quality data. A disposable-database transaction test verifies the full path. |
| TR-035 | Fixed and verified | After the canonical merge, two previously unresolved records gained new duration-based proposals, so a rerun could ignore their saved Keep Separate decisions and attempt to merge them into targets that already had transcripts. | Canonical planning now excludes every proposed or unresolved item with a durable Keep Separate decision and refuses an empty rerun. A regression test covers this post-merge state. |
| TR-036 | Fixed and verified | The integrity scanner compared disk basenames only, so collision-safe Otter audio paths looked orphaned after their Library display/device filenames diverged; the known 45-byte imported stub was also misclassified as an interrupted download eligible for deletion. | Disk ownership now uses the authoritative normalized `file_path` from recordings and synced files. Preserved source imports are excluded from destructive incomplete-download repair suggestions. A regression test covers both failures against one collision-safe stub import. |
| TR-037 | Fixed and verified | A first-pass speaker correction design could have assigned the global label “Speaker 1” to one person even though that label represents different people in different recordings. | Generic labels remain explicitly unresolved and the service rejects global assignment. The People interface explains that they require per-recording recognition/review. An integration regression proves the guard while named-label corrections and merges remain durable. |

## Delivery roadmap

### Foundation gate — Authoritative source chronology — In progress (current phase)

This gate applies to every later milestone. A recording has several legitimate timestamps, but only its source recording
date controls chronology:

- `date_recorded`: when the call actually happened — authoritative.
- `created_at`: when HiDock Next created its database row — audit metadata only.
- download/upload/transcription/export timestamps: processing history only.

- [x] Capture the P1/device recording timestamp and persist it as `recordings.date_recorded`.
- [x] Carry the original date through the durable download queue.
- [x] Apply the original date to the downloaded audio file's filesystem timestamp.
- [x] Use the recorded date for Library display and chronological sorting.
- [x] Use only the recorded date for calendar correlation; invalid dates do not fall back to upload time.
- [x] Preserve the recorded date in text/Markdown export metadata and exported file timestamps.
- [x] Use the recorded date for semantic-search/vector metadata (TR-023).
- [x] Remove upload/current-time repair and UI fallbacks; unknown must remain unknown (TR-024, TR-025).
- [x] Persist source-date precision (`exact`, `date-only`, or `unknown`) and its evidence. Date-only records display without a fabricated time and cannot drive automatic calendar matching (schema v24, TR-029).
- [x] Define and test the same invariant for PDF, batch export, and backup/restore.
- [ ] Extend the authoritative-date invariant to every future artifact type.
- [x] During Otter preview, recover the original conversation date where evidence permits and classify each result as exact, date-only, or unknown without consulting ZIP/export time.
- [x] Explicitly accept date-only Otter evidence during transactional import; persist the date with `time unknown` and never invent a time.
- [ ] Run a cross-system regression audit proving that later ingestion, transcription, reprocessing, and export never alter source chronology.

### Milestone 1 — Safe transcription foundation — Complete

- [x] OpenAI provider selection and encrypted API-key storage.
- [x] OpenAI transcription and transcript analysis.
- [x] Safe handling for recordings larger than 25 MB through sequential audio chunks.
- [x] Preserve P1 MP3 bytes and original recording timestamps.
- [x] Disable automatic download/transcription by default.
- [x] Persist and recover download/transcription queues safely.
- [x] Resolve device/synced IDs to canonical recording IDs.
- [x] Live-test a real 34-minute P1 recording end to end.

### Milestone 2 — Reliability and observability — In progress

- [x] Correct P1 version 5 duration calculation in code and tests.
- [ ] Confirm corrected durations against a refreshed live P1 file list.
- [x] Make Ollama configuration bundle-safe.
- [x] Stop per-chunk error storms when Ollama is offline.
- [x] Add a concise provider-status indicator: transcription configured/API key needed, local search ready/offline, with independent refresh.
- [x] Add per-recording processing history with provider, model, attempt, elapsed time, and errors; retain each future attempt and show legacy queue data when available.
- [x] Restore a clean project-wide `npm run typecheck` regression gate (TR-009).
- [ ] Restore the project lint regression gate under ESLint 9 (TR-027).

### Milestone 3 — Practical daily automation — Complete

- [x] Define a durable per-device discovery baseline and last-successful-sync boundary. The first scan baselines existing files without flooding the queue; later unseen filenames are detected even if their device timestamps are older.
- [x] Add a review queue for newly detected recordings before paid transcription. The Library exposes a Review filter, New badges, and reversible Mark Reviewed/Add to Review controls; explicitly queuing a download marks the item approved but never starts transcription.
- [x] Add optional rules for auto-download and auto-transcription with explicit enable confirmations and clear model-specific cost estimates. Auto-download is limited to newly discovered Review items; automatic paid transcription remains independently opt-in.
- [x] Correlate recordings with calendar meetings while keeping the device timestamp authoritative. Time-derived candidates remain suggestions unless transcript analysis selects a valid candidate at 0.75+ confidence; user decisions always win.
- [x] Generate useful default titles without overwriting the original filename. AI suggestions update only the Knowledge Capture title when it is still filename-like; custom titles and the recording filename are preserved.
- [x] Provide retry/cancel controls that remain correct after restart. Persisted failure metadata is restored into visible controls, and cancelling an active OpenAI job aborts the request without converting cancellation into a retryable failure.

### Milestone 4 — Ownership, export, and backup

- [x] Export a transcript as plain text and Markdown from the Library reader.
- [x] Preserve the original recording date in export metadata and the exported file's modified timestamp.
- [x] Export a polished PDF using the original recording date rather than the upload date. A six-page representative export was rendered through Electron and visually inspected on every page; the original timestamp, metadata, paragraph flow, and numbered footers are correct.
- [x] Support batch export with a manifest containing original filenames, dates, provider, and model. Selected completed transcripts can be exported as Markdown from the Library; duplicate output names are preserved with suffixes, each file receives its source timestamp, and skipped/failed items remain visible in the JSON manifest.
- [x] Add backup/restore for recordings, transcripts, speaker labels, and metadata.
  - [x] Create a versioned portable folder containing the database, recordings, transcript sidecars, and a SHA-256 manifest. Original file timestamps are preserved; API keys are deliberately excluded.
  - [x] Validate every declared file, size, checksum, schema version, required database, and path containment before restore. Validation is available as a read-only action in Settings.
  - [x] Add a pre-restore safety snapshot, restart-boundary replacement, rollback/quarantine behavior, and post-restore integrity scan. Restore is explicitly replace-only; merge remains a future import/reconciliation concern.
- [x] Reconcile the imported Otter export with the authoritative HiDock recordings without losing audio or transcripts.
  - [x] Add read-only ZIP inspection with source-date evidence, missing-file detection, transcript fingerprint deduplication, and speaker-label inventory.
  - [x] Scan the complete saved export: 642 audio files, 639 transcripts, 642 summaries, 208 exact timestamps, 434 date-only records, 3 missing transcripts, 1 archive-internal duplicate transcript, 130 speaker labels, and 0 records with no recoverable date.
  - [x] Add an explicit precision policy for the 434 date-only records: persist the calendar date as date-only, display “time unknown,” exclude it from automatic meeting correlation/calendar placement, and never use the ZIP/export timestamp.
  - [ ] Add optional review controls for resolving a date-only record to an exact time when trustworthy evidence exists.
  - [x] Add a transactional commit path that rechecks duplicates, stages selected audio, inserts recordings/transcripts in one database transaction, preserves exact source timestamps, persists date-only precision, and removes newly created files if the database commit fails.
  - [x] Run the first real staging import with explicit user confirmation. The app created a timestamped safety backup under the user's `HiDock/import-safety` folder first, then imported 641 non-duplicates: 638 with transcripts and 3 audio-only. One preview duplicate was excluded. Post-repair verification shows 651 total local recordings (10 prior + 641 imported), 0 duplicate local file paths, 0 invalid/implausibly old source dates, and a clean startup integrity scan. This preserves the Otter-export audio but does not yet prove or merge its relationship to the P1 originals.
  - [x] Run a read-only overlap analysis against the saved P1 inventory. The inventory contains 629 device recordings beginning November 24, 2025. Of 641 imported Otter items, 240 predate the saved device inventory and 401 overlap it. Exact device timestamps match 206; same-date audio duration matches add 161; adjacent-day date-boundary evidence adds 12.
  - [x] Build a non-destructive reconciliation preview that treats the P1/HiDock recording as the canonical audio source and proposes attaching the matching Otter transcript, title, summary, and speaker metadata. The preview is available in Settings and cannot merge, rename, or delete either side.
  - [x] Add a durable reconciliation review workspace with search, evidence filters, pagination, per-item confirm/keep-separate/pending decisions, safe bulk review actions, and a saved review plan. Schema v25 stores only review decisions; regenerated previews invalidate a stale confirmation if its proposed HiDock filename changes. There is still no merge action.
  - [x] Approve the streamlined reconciliation policy: accept all 379 high-confidence proposed pairs, keep all 22 unresolved overlapping items separate, and preserve all 240 pre-device Otter records. The live dry run applies that policy without mutating the library.
  - [x] Build a fingerprinted canonical-merge planner with collision detection, a mandatory portable safety backup, a transaction/audit batch, redundant-audio archival, and an exact confirmation phrase. The Settings surface exposes the dry run only; it has no live apply button.
  - [x] Run the planner against the live library. Result: ready, 379 accepted, 373 canonicalized in place, 6 consolidated into existing HiDock rows, 22 kept separate, 240 pre-device records preserved, and 0 blockers. No canonical merge was executed.
  - [x] After backup and explicit confirmation, merge only confirmed pairs into one canonical Library item while preserving the HiDock filename/date and all Otter-derived metadata; retain a reversible audit trail. Batch `80854198-39db-45a8-8f17-5e3b0c89a031` applied 379 mappings (373 in place and 6 existing-row consolidations), retained all 379 transcripts, kept 22 unresolved items separate, and preserved all 240 pre-device imports. The portable safety backup and six archived redundant audio files were independently verified afterward.

### Milestone 5 — Speaker recognition

- [x] Inventory speaker labels from the saved Otter export without importing data; the complete archive contains 130 distinct raw labels for normalization.
- [x] Normalize speakers from imported Otter transcripts into reusable identities while preserving every original label as evidence. The live index contains 111 named candidate identities from 130 raw labels.
- [x] Add an interface to correct and merge named speaker identities. Generic labels remain unresolved because their meaning is recording-specific (TR-037).
- [ ] Use confirmed historical labels as evidence for future speaker suggestions.
- [ ] Keep confidence scores and require confirmation before permanently assigning uncertain speakers.

### Milestone 6 — Universal knowledge hub

- [ ] Extend the same ingestion, metadata, search, and export pipeline to documents and notes.
- [ ] Link recordings, transcripts, meetings, people, projects, and derived insights.
- [ ] Make local search optional and independently configurable from paid transcription.
- [ ] Add cross-artifact summaries, questions, action items, and traceable citations.

## Active AI configuration

- Provider: OpenAI
- Transcription model: `gpt-transcribe`
- Analysis model: `gpt-6-luna`
- Automatic transcription: off
- OpenAI API key: configured (value is never recorded here)

## Latest verification

- Real P1/OpenAI run: 34:06 audio, 4,041 words, completed on the first attempt.
- Expanded reliability/regression suite: 480 tests passed across 16 files.
- Provider-status Settings suite: 13 tests passed.
- Transcription-history database/IPC suite: 96 tests passed; broader focused history/UI suite: 112 tests passed.
- Latest Library aggregation/title/logging regressions: 50 tests passed across 2 focused suites.
- Device-ingestion database integration plus Library/operation regressions: 49 tests passed across 4 focused suites.
- Reversible review workflow and device-ingestion regression suite: 64 tests passed across 4 focused suites.
- Safe auto-sync selection, device identity, and current pricing utilities: 74 tests passed across 7 focused suites; Settings/pricing subset: 20 tests passed across 3 suites.
- Broader database/recording suite: 93 tests passed before export work; the updated focused suite remains green.
- Production Electron build: passed.
- Project-wide node-and-web typecheck: passed.
- Full default Electron test gate: 1,446 tests passed across 87 files with deterministic file isolation.
- Meeting-correlation policy plus calendar/transcription regressions: 37 tests passed; title-preservation/database policy: 43 tests passed; project-wide typecheck remains clean.
- Restart hydration and active-cancellation regressions: 83 focused tests passed; production Electron build and project-wide typecheck passed afterward.
- Authoritative-date focused suites: 302 tests passed, including real schema-v22-to-v23 migration, unknown-date ingestion/UI/download safety, semantic indexing chronology, and integrity-review policy.
- Latest full default Electron gate: 1,461 of 1,463 tests passed across 92 files. The two wall-clock Library performance assertions exceeded their budgets only under full-suite load; the complete performance file then passed 6 of 6 in isolation (112.70 ms filter, 104.26 ms view switch). No functional regression failed.
- Latest project-wide node-and-web typecheck and production Electron build: passed after the source-date changes.
- Batch export backend/reader regression suite: 91 tests passed; Library suite: 9 tests passed. Project-wide typecheck and production build passed after the batch-export UI and manifest path were added.
- PDF visual QA: six A4 pages rendered with the real Electron footer; every page inspected after fixing paragraph splits. Text extraction confirmed the original timestamp, original filename, and final transcript paragraph; the exported file timestamp matches the source recording date. Focused PDF tests, project-wide typecheck, and production build passed.
- Portable backup and restore: 9 service tests cover complete creation/validation, source timestamp preservation, tamper detection, path traversal rejection, unsafe destination rejection, staged restart-boundary replacement, no-pending behavior, quarantine without live-data changes, and bounded retry of transient Windows rename locks. The Settings backup UI suite passes 14 tests; project-wide typecheck passes after the retry fix. Restore is replace-only, creates a safety backup first, applies before database startup, and then runs the normal integrity scan.
- Lint gate: `npx eslint` cannot start because ESLint 9 requires a flat configuration and the Electron app currently has none (TR-027). This is tracked separately; no lint results were claimed for the restore work.
- Otter read-only import preview: the complete 3.59 GB archive was scanned in place without extraction or database writes. It contains 642 conversations; 208 have exact source timestamps, 434 have date-only evidence, 3 lack transcripts, 1 duplicates another transcript in the archive, and 130 distinct raw speaker labels were found. Four service regressions plus the 15-test Settings suite pass.
- External recording insertion regression: the full lifecycle/source field set is now persisted (TR-028); the focused database/import/Settings run passes 54 tests across 3 files.
- Source-date precision foundation: schema v24 migration preserves existing chronology while marking legacy rows exact; exact/date-only/unknown metadata now reaches Library views and Otter preview. Date-only items cannot create midnight calendar matches or placeholders, and device saves no longer fall back to the current time (TR-029). The focused migration/database/Otter/Library/calendar run passes 130 tests across 7 files; project-wide typecheck passes.
- Transactional Otter commit path: staged extraction, current-library duplicate recheck, exact/date-only persistence, one SQL transaction, and failure cleanup are covered by synthetic ZIP regressions. The focused database/import/migration/Settings run passes 58 tests across 4 files.
- First real Otter staging import: the safety backup completed before mutation; 641 non-duplicates were imported from the 642-conversation archive (638 transcripts, 3 audio-only, 1 duplicate excluded). Live verification reports 651 local recordings, 3.74 GB total storage, 218 exact and 433 date-only source dates, no duplicate local physical paths, no invalid/implausibly old dates, and 0 startup integrity issues. The import exposed and verified fixes for the watcher race (TR-030) and over-broad filename date parsing (TR-031); 47 focused database/import/integrity tests and the node typecheck pass afterward.
- Otter-to-P1 reconciliation preview: the live saved device cache contains 629 recordings from November 24, 2025 through October 16, 2026. Of 641 imported Otter items, 240 predate that inventory and 401 overlap it. The live read-only preview found 206 exact-timestamp pairs, 161 same-date/duration pairs, and 12 adjacent-day date-boundary pairs whose durations differ by less than 0.1 seconds (379 proposed pairs total). The 22 remaining items split into 10 with no unused P1 recording on the same date and 12 with major duration conflicts; none remains a close-duration fingerprint candidate. Three pre-P1 Otter items lack transcripts, but all three exported audio files are unusable ID3 stubs rather than transcribable meetings (TR-032). The reconciliation/Settings subset passes 20 tests and project-wide typecheck passes. No canonical merge, rename, or deletion has run.
- Current repository gate after the reconciliation and Windows backup-lock fixes: all 1,497 Electron tests pass across 96 files, project-wide node-and-web typecheck passes, and the production Electron build passes. Vitest's own cache rename reproduced the sandbox-specific Windows `EPERM`; the same test run completed cleanly outside that restricted temporary directory.
- Reconciliation review workspace: schema v25, persisted review decisions, stale-pair protection, searchable/paginated evidence review, safe bulk classification, and an explicit no-merge UI are covered by 23 focused migration/service/Settings tests. The full gate passes 1,499 tests across 96 files, project-wide node-and-web typecheck and the production build pass, the live database migrated cleanly with zero integrity issues, and the live visual check confirmed the 379 proposed/22 unresolved/401 pending review state without changing a recording.
- Canonical merge dry run: schema v26 adds batch/audit records; the planner uses a SHA-256 fingerprint and blocks stale or conflicting execution. Focused planner, migration, reconciliation, and Settings coverage passes 27 tests; a separate disposable-database integration test proves in-place canonicalization, existing-row consolidation, transcript transfer, unresolved preservation, redundant-audio archival, and audit creation. The project-wide node-and-web typecheck and production build pass. The full Electron gate passed 1,503 of 1,504 tests; its only miss was the known load-sensitive jsdom view-switch budget at 208 ms versus 200 ms, and that complete six-test performance file passed alone with a 121 ms view switch. The live read-only plan is ready with 379 accepted mappings (373 in place and 6 existing-row consolidations), 22 kept separate, 240 pre-device records preserved, and 0 blockers. Live data has not been merged.
- Canonical merge applied and audited: batch `80854198-39db-45a8-8f17-5e3b0c89a031` used fingerprint `eec74c78476ee08f67b24c2b317cbd38b98b22b64955c928d7a8315cb26c78a9` after creating `HiDock/merge-safety/hidock-next-backup-20261018T192847Z`. Its 652-file, 3,738,004,725-byte manifest passed a complete size and SHA-256 validation. The live database contains 401 applied audit rows: 379 canonicalized and 22 kept separate. All 379 canonical rows exist, retain transcript rows, and match the device timestamp stored in their after-snapshot; 0 chronology mismatches were found. Six redundant imported audio files exist in the batch reconciliation archive, their source rows are gone, and their canonical targets remain. Total Library rows changed from 651 to 645 exactly as expected; 262 imports remain (240 pre-device plus 22 kept separate). Post-merge verification exposed and fixed saved-decision rerun protection (TR-035) and collision-safe physical-path integrity handling (TR-036); the restarted app then reported 0 pending canonical actions and 0 integrity issues.
- Speaker identity foundation: schema v27 preserves raw transcript labels separately from reusable identities and occurrence evidence. The live rebuild indexed all 130 Otter labels across 3,251 transcript/label occurrences into 111 named candidates plus 19 unresolved generic labels; it does not alter transcript text or chronology. The People page now supports confirmation/rename and explicit duplicate merges. Generic labels cannot be globally assigned (TR-037). The disposable-database integration test, project-wide typecheck, and production Electron build pass.
