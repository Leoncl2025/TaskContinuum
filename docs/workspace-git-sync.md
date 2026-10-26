# Automatic workspace links

Task Continuum can synchronize public device identities, recipient-bound
invitations, session bindings and typed remote settings through the workspace's
existing Git upstream. Task documents retain the fixed AgentDesk-compatible
format; their checker is owned by TaskCon.

## Enable

1. Open the repository root as a task workspace. Its current branch must track
   one existing remote branch; no `main` or remote URL is guessed.
2. Open **Remote devices** in the activity bar.
3. Sign in to the same owner account for the private Dev Tunnel on each device.
4. Under **Automatic workspace links**, select **Enable automatic links** and
   read the native consent dialog. Do this on existing B/C before enrolling A.

Consent covers publishing the public metadata and using immutable Agent Host bindings,
automatic metadata exchange with signed devices in this shared repository, and
read and send access to previously owner-confirmed linked sessions, plus explicit
native session creation and assignment in this shared workspace. Write access
includes association; there is no additional per-device session-link permission.
Existing read-only grants for active enrolled devices are upgraded on reconciliation,
including after restart. Other workspaces and revoked devices are not granted access.
Linking does not automatically create a session or send a prompt, grant OS shell
access, approve tools, or generate owner receipts from remote binding data.
Manual pairing, identity/invitation file exchange and per-device access switches
are no longer part of the UI. Pause, disconnect and device revocation remain available.

An unconfigured workspace only reads its documents. Session binding reads and
writes require enabling the immutable backend; there is no legacy fallback.
Opening a workspace or
canceling the native dialog does not create Git enrollment or publish keys.
Pause stops automatic synchronization and workspace connections; it does not
fall back to the archived binding file.

## Switching branches

No local or remote branch is permanently bound to enrollment. Each Git cycle
uses the **current local branch's configured upstream**, including task branches.
Neither `main`/`master` nor the remote default branch is selected implicitly.
Switching back to `main` after merging and deleting a task branch needs no
reenrollment. The metadata-only cache, pending immutable records and device trust
remain intact and are reconciled with the newly selected upstream.
Existing published or enrolled workspace IDs are preserved. New workspace IDs
are derived from the repository URL, not the branch name.

Without an upstream, or with detached HEAD, Git synchronization reports a visible
error and waits for a tracked branch. The workspace still opens, cached bindings
remain available, and local configuration edits remain durable and pending.
Once a valid upstream is available, the next tick or **Sync now** resumes sync.
The app does not create an upstream branch or configure tracking for the user.

Only branch selection follows the checkout. Changing the remote repository URLs
still requires explicit trust review. A switch during a running cycle aborts that
publication; the next cycle captures the new target. Accepted-history checks are
retained per upstream target, so switching away and back cannot hide a rollback.
Peers on different upstream branches need not see the same configuration until
those branches receive the records; task documents always reflect the user checkout.

## Timing and the A/B/C exchange

- Git operations use the **same repository checkout selected in the workspace**.
  Task Continuum does not clone the AD repository or create another worktree.
  Task documents and public configuration have one editable location.
- Git synchronization is fixed at **15,000 ms** while enabled.
- A local configuration change durably saves its immutable operation, then
  immediately schedules Git publication when the checkout is safe. A binding change also immediately
  notifies the affected SSH peers without waiting for Git completion.
- Git operations are serialized; edits during a running cycle coalesce into
  follow-up work. Overlapping timer ticks are skipped so slow Git operations do
  not keep the UI permanently waiting. Push races have at most three attempts per cycle.
- A discovers B/C public identities and publishes separate A-issued invitations.
  B and C consume their respective invitations and independently publish
  reciprocal invitations. An invitation issued by X to Y enables **Y -> X**.
- Each device authenticates both the Dev Tunnel route and the SSH key. The
  control exchange carries private device invitations only inside SSH, not Git.
- Device connection does not itself create a session or attach an unrelated
  conversation. Normal task/session authorization continues to apply.

Existing pairs can continue independently of another offline device. Repeated
polling and restarts reuse stable identities, saved ports and existing grants;
requests and private tokens are not stored in the public records.

## Durable device trust (one format, breaking change)

Public `invitation/grant` records require `lifetime: "until-revoked"` and do not
have an `expiresAt` field. Timestamp expiry and `expiresAt: null` are both
rejected, including correctly signed old records. The desktop has no compatibility
reader, migration button, downgrade mode or daily renewal branch. Enabling
automatic links uses this format directly. This repository no longer includes
the standalone one-time trust migration CLI or a legacy-history conversion tool.

A grant is bound to the exact issuer/recipient identity publications, signing
key and route identity. An unchanged relationship reuses its signed operation
across elapsed days, reloads, reconnections and restarts. Real identity/route
changes can require new operations; machine aliases do not change identity.
Revocation tombstones are not automatically reinstated. Device removal, pin
revocation, unapproved key changes, conflicting history and missing accepted
records still block access.

Metadata SSH access and private device SSH credentials have separate APIs and
budgets. Metadata access requires the enrolled SSH key, the exact workspace/device
grant and a mandatory live trust callback. Each control request has a signed
nonce/timestamp and an at-most-60-second lifetime. Replay detection and
authorization before and after asynchronous work remain enforced. The durable
relationship opens only the metadata port, not an OS shell or session port.
Established metadata connections recheck trust at least every second and before
forwarding; explicit revocation closes them.

Session/file access uses a separate encrypted private device credential, issued
for 30 days and renewed within one hour of expiry through the authenticated
metadata exchange. Renewal rotates the token without a public Git write,
preserves the pairing ID and all existing workspace scopes, and invalidates old
gateway authorization. An expired saved credential can reach the trusted renewal
path; it cannot authenticate a session itself. Private SSH registration enforces
the same 30-day lifetime with one minute of clock tolerance, rather than the old
mixed 25-hour/31-day rules. Session bindings, owner receipts, identity pins and
read/send checks still apply. Renewal never recreates a session or replays a prompt.
Revoked private workspace scopes are removed from the verified snapshot even
before the metadata grant registry has been restored. Concurrent cleanup is
coalesced, and a later private grant waits for that cleanup before restoring scope.

SSH registration permits 32 private-device grants and, separately, up to
32 devices x 10 enrolled workspaces = 320 metadata grants. Live SSH connections
retain separate 32-connection device and metadata budgets (64 combined), so
private session traffic cannot consume every metadata slot. Registration is not
a promise of unlimited simultaneous connections. Forwarding has separate
64-device-channel and 32-metadata-channel budgets; saturated session forwards
cannot consume the control channel budget either.

### Rebuilding configuration and retaining baseline protection

All participants must use the same approved build and configuration baseline.
Opening old invitation history fails closed with an unsupported-format error;
the program does not rewrite it, silently omit it, or convert old grants.

**Deleting only invitation JSON files is not sufficient.** Accepted operation
IDs, causal parents, locally retained publications and Git ancestry protect
against removal and rollback. Clearing one cache is not a supported reset.

An intentional rebuild is a separate configuration, not an in-place import of
old authorization. Retain the original workspace and profile, use a separate
workspace directory without the old `.taskcontinuum` metadata, and start each
device with its own new profile. A new repository is not required: a different
workspace-relative path in the same repository has a separate initial workspace
identity. Changing only the branch or local checkout location is not enough.
Task documents can be copied after review, but nested repositories and native
session working directories require their own handling. Do not copy old keys,
enrollment pins, caches, outboxes or owner receipts into the new profile.

Rebuilding creates new identities and requires explicit authorization and
owner-confirmed links to existing sessions. It does not preserve old grants,
aliases or bindings. The normal automatic-links consent includes read/send;
do not enroll a device that must remain read-only or use a new identity to bypass
a revocation. Keep old installations out of the new workspace. Sharing a Git
repository does not isolate repository write permissions.

Already migrated workspaces still use their schema-v2 public descriptor and
schema-v3 private runtime metadata. Runtime checks retain signed approvals,
exact preserved-record hashes, accepted history, the pinned baseline and the
approved participant/directed-grant policy, including read-only scopes. Removing
the CLI does not remove these protections or enable automatic old-format import.
Prepared or interrupted migrations remain blocked; this build cannot complete
them. Keep their data and checkpoints intact for an explicitly reviewed recovery,
rather than deleting markers or resetting the profile.

### History cost

The 10,000-record/64-MiB immutable-history guards and 32-KiB per-record guard
remain. Normal trust no longer consumes one record per day, but actual edits,
explicit revocations and deliberate regrants still accumulate. Cold verification
and filesystem freshness checks still scale with retained history. There is no
automatic compactor.

[The cost regression](../test/durable-trust-cost.test.ts) constructs two fixed
devices and 50/400/1,000 explicit grant/revoke decisions, all in the new format.
It persists accepted state, closes the store, then measures cold reopen, initial
authorization, 100 warm lease checks and unchanged refresh. It reports metadata
checks, directory reads, opens, JSON parses, signature verifications, elapsed
time and the actual difference in public operation IDs. Fixture construction is
outside the measured interval. Warm-cache results are not a claim that history
has constant cost.

Measured on Windows with no other test runner active:

| Trust decisions (+2 devices) | Cold ms | Metadata checks | Directory reads | File opens | JSON parses | Signature checks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | 160 | 291 | 21 | 58 | 53 | 52 |
| 400 | 777 | 1691 | 21 | 408 | 403 | 402 |
| 1000 | 1916 | 4091 | 21 | 1008 | 1003 | 1002 |

Initial authorization took 19/29/51 ms and inspected 73/423/1023 metadata
entries, seven directories and one file, with zero JSON parses or signature
checks. Unchanged refresh took 27/46/75 ms and inspected 78/428/1028 metadata
entries and seven directories, opened five files, parsed one local-state JSON
and performed zero signature checks. Each set of 100 warm checks took 2 ms with
zero filesystem, parse or signature operations. Actual public-record growth was
zero at all three sizes. These are local fixtures, not remote deployment results.

### Related limit/lifecycle audit

| Area | Finding and disposition |
| --- | --- |
| Public trust | Fixed: a stable relationship no longer periodically creates immutable Git records. |
| SSH grant slots | Fixed: per-device private grants and per-workspace metadata grants no longer compete for one 32-entry registry. Separate live connection budgets protect the control path. |
| Private credential lifecycle | Fixed: expiry can use current public trust to renew; renewal retains the pairing identity and other workspace scopes instead of revoking/recreating the pair. |
| Local/remote chat connection caches | Still a lifecycle defect: [local](../src/main/agentHostRegistry.ts) 64 and [remote](../src/main/agentHostManager.ts) 32 entries accumulate until manager shutdown, not just while a view is open. A safe fix needs ownership/idle eviction protecting running sends, uncertain delivery, terminals and native empty-session subscriptions; blindly closing old connections can lose an empty native draft. |
| Per-chat delivery ledger | Still a growth limit: [the ledger](../src/main/agentHostConnection.ts) retains up to 1,000 delivery IDs, including terminal states, and then refuses another send. It needs durable deduplication checkpoints/archival, not arbitrary deletion or a larger number. |
| Session creation history | Still a growth limit: [worker operations](../src/main/agentHostCreationService.ts) and [caller history](../src/main/agentHostCreationClient.ts) retain up to 1,000 operations. Failed/abandoned entries also occupy capacity. Archival must preserve operation-ID replay protection and uncertain native outcomes. |
| Device/workspace history | Still coarse accounting: [private client storage](../src/main/vscodeDeviceClient.ts) counts workspace/owner entries toward 32, not distinct physical devices. [Enrollment](../src/main/remoteConfig/enrollment.ts) counts paused workspaces toward 10 and revoked identity tombstones toward 32. Separate live capacity from retained revocation identity before adding removal/re-enrollment UX. |
| Session bindings | Product/protocol constraints remain: 1,000 linked sessions/tasks, one owner/session claim even for distinct chat IDs, and a 32-KiB complete signed task-binding payload. Effective per-task capacity can be lower than the workspace session count. Parent/child and multi-chat linking need a separate explicit design. |
| Retained configuration | Cold verification is history-sized; unchanged refresh still scans record metadata. A later compactor needs accepted-head commitments, signed ancestry, revocations, offline-peer policy and explicit cutover. Do not delete accepted history or merely raise the cap. |
| Request/transfer guards | Retained intentionally: short signed request lifetime, replay TTL/capacity, bounded concurrent handlers, transport timeouts, 16 active UI watches and file-transfer byte/count quotas. Transfers expire and are cleaned after 24 hours; their 128 retained-item limit is not a permanent lifetime counter. |

The audit identifies remaining work explicitly; this trust change does not
silently redesign chat ownership, deduplication or all application resource limits.

## Machine aliases

In **Remote devices > Automatic workspace links**, use the alias editor beside
this machine or an enrolled peer. Saving names a machine; clearing the alias or
saving a blank value restores its original hostname. Edits require automatic
workspace links to be enabled. Existing aliases remain available from cached
configuration while synchronization is paused or offline.

Aliases are workspace-scoped, shared by enrolled desktops, and keyed by the
stable device ID, not by hostname, pairing ID or SSH route. Any enrolled editor
can name a known machine in that workspace. Unicode and spaces are supported;
leading/trailing spaces are trimmed, and names are limited to 80 characters with
no control characters or line breaks. Names do not have to be unique.

Device lists, the session sidebar's Current and Link views (including search),
local and remote creation details, chat machine labels and the workbench status
use the alias when available. The original hostname remains discoverable. Renaming
never changes the machine identity, private pairing, session owner, binding,
selected creation target or active conversation.

Alias edits use separate signed `alias` records and the same durable outbox and
Git synchronization as other public configuration. Restart does not lose a saved
alias. They are public workspace metadata; do not use secrets as aliases. All
enrolled desktops must use an alias-capable build before publishing these records;
older builds reject unknown record types instead of silently ignoring them.

Concurrent incompatible aliases show a configuration conflict and fall back to
the hostname; they do not disable otherwise valid connections or session bindings.
Save the intended name or clear it at the current revision to resolve every
observed alias head. A stale edit is rejected rather than overwriting a newer name.
Never edit or delete signed record files to rename a machine.

## Provisional bindings

When A binds a task to a B-owned session, A sends the exact signed binding
operation and bounded dependency closure over SSH while publishing it to Git.
B validates it and immediately presents a local provisional view. B also
requests an immediate pull; the normal 15-second schedule remains the fallback.

The provisional operation is removed only when that exact operation is present
in validated canonical Git data. A successful pull before A's push is **not**
confirmation: B keeps the temporary view. Canonical descendants and concurrent
operations use the same resolver, not unconditional temporary-value precedence.

Provisional values have a 60-second lifetime. Expiry/restart leaves an explicit
awaiting-sync marker and disables the affected binding rather than silently
reactivating an older route. Restore the publisher/upstream and sync the original
operation to resolve that marker. Never delete immutable history to clear it.

## Storage and conflicts

Public Git data:

```text
.taskcontinuum/workspace.json
.taskcontinuum/records/v1/devices/<deviceId>/<operationId>.json
.taskcontinuum/records/v1/aliases/<deviceId>/<operationId>.json
.taskcontinuum/records/v1/invitations/<issuerId>/<recipientId>/<operationId>.json
.taskcontinuum/records/v1/bindings/<taskId>/<operationId>.json
.taskcontinuum/records/v1/settings/<scope>/<key>/<operationId>.json
```

Each operation is signed, hash-addressed and immutable. Git merges add files
instead of rewriting one shared registry. Different entity keys combine.
Git's LF/CRLF checkout conversion is accepted without changing the user's Git
settings or rewriting local files; all other canonical-content, hash and signature
checks still apply.
Each task binding operation stores the task's complete session array. Concurrent
incompatible changes to the same task retain both authors' operations and produce
**needs resolution**; ambiguous bindings are disabled. Reassigning the intended
session set or explicitly detaching an exact session with the current revision
resolves known heads. The same canonical owner/session cannot appear twice,
including as different chats or under different tasks.

The local app-data directory holds protected SSH keys, native private
invitations, enrollment pins, the outbox, overlay markers, configuration editor
state and a metadata-only cache of previously accepted signed records. This cache
contains no Git checkout, `.agentdesk` folder or task documents; it supports
offline startup and branch changes, and is not a second editable AD repository.
Pending configuration is kept in the outbox until Git publication succeeds.
Generated views are not a second Git authority.
The private key store continues to use OS protection.

Session binding documents and signed binding payloads accept only schema v2.1 arrays,
identified by the string `"schemaVersion": "2.1"`, not the number `2.1`.
Earlier binding formats, including signed v2 single-target history, are unsupported
and block the configuration; no migration, partial import, or automatic reset occurs.
Archive the old configuration and initialize a fresh workspace metadata set before
manually linking the existing native sessions again. Cached records and pending
outboxes belong to the old enrollment too; deleting individual Git records is not
a migration. Do not rewrite signed history. All participating desktops need v2.1 support.
Creation operation records and local authorization receipts keep their separate v2
schemas; native session history and keys are untouched.
Bindings accept only logical `agent-host` targets with `sessionId`,
`chatId` and a stable owner (`clientId`, `machineName`). GitHub Copilot SDK,
VS Code journal and ownerless binding formats are unsupported, including
inside signed Git records and SSH notifications.

The old `session-bindings.json` and workspace-keyed browser bindings are not
read, migrated or written. Existing files remain untouched; even malformed
old data cannot become active or block the new store. Enable Automatic workspace
links, then explicitly select the existing Agent Host sessions again. There is
no migration button or migration IPC. Existing incompatible local store metadata
or authorization receipts are reported as unsupported, never reset or imported.
Do not delete immutable history, private identities or pending outboxes to bypass
an error.

## Settings and recovery

### Configuration transaction locks

The private `workspace-sync/<workspace-hash>/store/store.lock` records its
workspace ID, machine hostname, process ID and a unique ownership nonce before a
configuration transaction starts. On restart, Task Continuum automatically
reclaims a well-formed lock only when it belongs to this workspace on this machine
and the operating system confirms that its process no longer exists. It then
recovers the existing pending-operation journal before reading or changing
configuration; bindings, receipts and session history are not reset or replayed.
A successful stale-lock recovery appears in diagnostics as
`configuration.transaction`, step `workspace-recovery`, status `ok`.

A live PID (including a reused PID), an inaccessible process, a different machine
or workspace, or an unrecognized/empty legacy lock is never reclaimed based on
age. The error distinguishes a live owner from an owner that cannot be verified.
Recovery itself is serialized by `store-recovery.lock`, and release verifies the
file identity and ownership nonce before removing a lock. Symbolic links and
hard-linked lock files are rejected.

If ownership cannot be verified, or an interrupted recovery leaves
`store-recovery.lock`, stop **all Task Continuum instances using that data
directory**, verify their processes have exited, and rename only the indicated
lock to a timestamped backup before restarting. Never remove a lock while an
instance is running. Keep `store.json`, `pending-operations.json`, the outbox,
receipts and task files intact. A blank task view after `store-busy` means workspace
loading failed, not that its tasks were deleted.

This is crash recovery, not a timeout for a live transaction. A deadlock in a
still-running process requires a separate fix; waiting longer must not grant
another process permission to write concurrently.

### Local settings

**Edit local configuration** opens a generated JSON projection in app data. Edit
only its values, not its base revision or causal frontier. UI and file changes
use the same typed write path. Per-setting heads let file edits survive unrelated
binding, Git or other-device changes without inventing new causal history.
Actual same-setting changes are retained as proposals with a visible error;
selecting the intended value in the UI resolves against the latest revision.
Generated refreshes and recovered editor exports do not create echo operations.

| Setting | Default | Meaning |
|---|---|---|
| `autoLink` | `true` | Establish this workspace's automatic peer links |
| `tunnelEnabled` | `true` | Allow this workspace's SSH connections |
| `connectTimeoutMs` | `45000` | Connection deadline, 1000–120000 ms |

The Git interval is not configurable. Disabling connections applies locally
without waiting for a successful Git push; network/store failures remain visible.

Startup restores every enrolled workspace's authoritative backend before
exposing saved device grants, including workspaces not selected in the UI.
Cached restoration does not require contacting Git or having a tracked branch.
Branch changes between cycles are allowed; remote repository identity changes
still block publication. Automatic refresh never rebases unpublished user commits
or stages unrelated files.

Revocation persists a local denial and closes access independently of public
record publication. Replayed metadata cannot reinstate a blocked device.
Fingerprint changes are blocked, not trusted automatically: deliberate key
replacement requires explicit reenrollment/trust policy rather than replacing
the saved private identity on startup.

Synchronization pauses with a visible error while the selected checkout has
user edits, staged changes, unpublished user commits or an in-progress merge,
rebase or cherry-pick. Task Continuum does not stash, discard, stage or publish
that work. Finish the Git operation and commit/push or otherwise resolve your
changes, then use **Sync now** or wait for the next cycle. Only allowlisted public
`.taskcontinuum` metadata is automatically committed by the background sync.
The separate **Create task** action commits and pushes only its generated task
files, using the same checkout and Git lock. It does not include unrelated edits.

This is a breaking local sync-state change. Old replica-based state is rejected,
not migrated, reused or automatically cleared. Start with a fresh Task Continuum
data directory and explicitly enable automatic links again. Existing old files
and pending operations are left untouched for manual recovery; they are not
silently imported into the new state. No new replica is created.
The first synchronization with an upstream target validates its **current
configuration snapshot** and establishes a baseline. Record deletions or reverted
edits before that baseline do not block a new enrollment solely because they
appear in Git history. This does not migrate old records, clear device trust or
import missing historical authorization: review the current configuration when
enabling links. Invalid signatures, unsupported records and missing dependencies
in the current snapshot still block synchronization.

After a target has an accepted baseline, force pushes and immutable record
mutation/removal after that baseline still block synchronization. Existing
enrollments do not silently reset their accepted history or pending records.

## Checks

Run the existing product tests and headless checker described in
[task-documents.md](task-documents.md). `check` now also checks public remote
record schema/hash/path/signature consistency and scans those files. CLI
consistency checking does **not** confer local device trust.

The regression suite includes independent local Git clones, real loopback SSH,
delayed publication/pull-before-push, duplicate/out-of-order messages, expiry,
conflicts, restart recovery, paused/revoked asynchronous grants, dynamic upstream
fencing and native Electron consent UI. Cloud-account and physical multi-machine
deployment must be validated in the user's approved environment; local SSH
fixtures are not represented as a live Dev Tunnel deployment.
