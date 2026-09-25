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
