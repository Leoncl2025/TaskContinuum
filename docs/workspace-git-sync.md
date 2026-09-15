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

## Timing and the A/B/C exchange

- Git synchronization is fixed at **15,000 ms** while enabled.
- A local configuration change durably saves its immutable operation, then
  immediately schedules Git publication. A binding change also immediately
  notifies the affected SSH peers without waiting for Git completion.
- Git operations are serialized; a tick/edit during a running cycle coalesces
  into follow-up work. Push races have at most three attempts per cycle.
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
Concurrent incompatible values retain both authors' operations and produce
**needs resolution**; ambiguous bindings are disabled. Reassigning the intended
session or explicitly detaching with the current revision resolves known heads.
The same canonical session cannot have two active task claims.

The local app-data directory holds protected SSH keys, native private
invitations, enrollment pins, the outbox, overlay markers, configuration editor
state and an isolated Git replica. Generated views are not a second Git authority.
The private key store continues to use OS protection.

Session bindings accept only `agent-host` targets with `hostId`, `sessionId`,
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
Cached restoration does not require contacting Git. A branch/upstream change
blocks edits/publication until the original enrollment is reviewed; automatic
refresh never rebases unpublished user commits or stages unrelated files.

Revocation persists a local denial and closes access independently of public
record publication. Replayed metadata cannot reinstate a blocked device.
Fingerprint changes are blocked, not trusted automatically: deliberate key
replacement requires explicit reenrollment/trust policy rather than replacing
the saved private identity on startup.

The protected-source checkout is refreshed only when safe. A dirty checkout is
left untouched while the app-owned replica handles metadata. Force pushes,
record mutation/removal, invalid signatures and unsupported records block
synchronization with an actionable error.

## Checks

Run the existing product tests and headless checker described in
[task-documents.md](task-documents.md). `check` now also checks public remote
record schema/hash/path/signature consistency and scans those files. CLI
consistency checking does **not** confer local device trust.

The regression suite includes independent local Git clones, real loopback SSH,
delayed publication/pull-before-push, duplicate/out-of-order messages, expiry,
conflicts, restart recovery, paused/revoked asynchronous grants, source-branch
fencing and native Electron consent UI. Cloud-account and physical multi-machine
deployment must be validated in the user's approved environment; local SSH
fixtures are not represented as a live Dev Tunnel deployment.
