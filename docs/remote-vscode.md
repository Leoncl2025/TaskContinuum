# Remote Agent Host Devices

Remote mode connects a Task Continuum desktop on A or C to the existing GitHub
Copilot Agent Host on B. It retains the original `sessionId`, `chatId` and owner,
with B's native account, tools and execution environment. A runtime Host instance
is a discovered connection endpoint, not part of the persisted chat identity.

**Runtime boundary:** Local Copilot SDK execution, CLI resume/import,
journal/Companion sessions, shared SDK Hosts/checkpoints and their session IPC are
retired. This filename remains for stable links, not as an extension installation
guide. Existing sessions, profiles and key files are left untouched.

## Agent Host (AHP)

Only **Host-owned Copilot sessions** using the official AHP 0.9.0 protocol are
supported. Both Task Continuum desktops need compatible builds. B needs a running
VS Code 1.137 Agent Host supporting AHP 0.9.0 and its normal provider sign-in.
Enable **Automatic workspace links** for the task workspace on both desktops
before reading or writing bindings; an unconfigured workspace reads task documents
only. See [workspace enrollment](workspace-git-sync.md).

The selected AgentDesk folder may live inside a larger Git checkout. For example:

```text
root/.git
root/Project/.agentdesk/config.json
root/Project/tasks/...
root/Project/.taskcontinuum/workspace.json
```

Automatic workspace links still enforce cleanliness, tracked-upstream checks and
other safety rules against the whole repository rooted at `root/.git`, while the
public Task Continuum metadata stays under the selected AgentDesk folder's own
`.taskcontinuum` directory.

To link an existing session:

1. On B, open the task workspace and **Agent Host sessions**. Approve access once,
  choose an existing Host chat, and link it to the selected task. A task already
  linked to another conversation must be explicitly detached first; this does not
  delete its history. No Host or chat is created automatically.
2. Let **Automatic workspace links** connect the enrolled devices with read
  and send access; no separate session-link permission is needed.
  B's current validated binding **and** private local confirmation receipt
  authorize access.
  A Git-only edit, a different owner Client ID, or a sibling chat is not authority.
3. Automatic workspace links publishes the immutable binding and immediately
  notifies affected SSH peers. Select the task on A. The enabled device route
  reconnects through the same private Dev Tunnel and SSH gateway port.
  The session endpoint token never leaves B. No new cloud resource or public port
  is required; the app does not modify OS SSH/firewall configuration.
4. Send explicitly in **AGENT HOST**. Live text and terminal output do not wait for
  VS Code journal saves. Stop targets the exact active turn, with read/send access.
  Provider sign-in, tool confirmations and agent questions still use the owner UI.

### Create on This Computer

In **Agent Host sessions**, select an unbound task and change **Execution location**
from its default **Remote worker** to **This computer**. The trusted local adapter
selects this machine and only the current canonical task workspace; the renderer
cannot supply another folder. Choose the exact available Copilot Host and click
**Create and assign**. This creates a native local session and assigns its confirmed
session/chat identity to that task, writing the binding and private owner receipt
before reporting **Created and assigned**.

The Host must already be running and signed in. Local Host consent, read/send
access, and the same authoritative workspace binding backend required by **Link**
are mandatory. Currently, enable **Automatic workspace links** for this task
workspace; a documents-only workspace cannot create a task binding. Creation does
not silently enroll a workspace or enable networking, remote pairing, SSH, or a
Dev Tunnel. Local discovery and creation do not consult paired devices. After
binding, existing paired-device workspace sharing policies still apply to the
chat; local execution does not make the binding private or disable sharing.
Missing consent, an offline Host, unavailable task bindings, and unreadable
creation records are surfaced as errors and keep creation disabled. An older
desktop API that returns remote workers for this choice is rejected, not treated
as a local worker.

Local task creation uses the current workspace with native **Folder** isolation
(no worktree), normal tool approvals on this computer, and no initial or warm-up
prompt. Model selection and the first send remain explicit. It does not use the
workspace **With agent** assistant's separate local creation flow. **With agent**
helps with workspace setup; **Create and assign** binds a new chat to a selected
task; **Link** binds an existing chat.

Local and remote creation share durable caller history and a per-task reservation.
Switching location cannot discard an uncertain operation or allow a second chat
for that task. The location control is disabled while discovery or an operation is
in flight. Reopening the controls checks the same saved operation; **Retry binding**
only assigns the existing chat. Resolve any pending local or remote operation
before attempting another creation in either location.

### Create on a Remote Worker

In **Agent Host sessions**, keep **Execution location** set to **Remote worker**
and use **Create on remote worker** for an unbound task.
Select a paired worker, one of its shared task workspaces, and the exact available
Copilot Host. Existing **Read and send** workspace access includes creation:
there is no separate create permission or approval. Read-only, expired, revoked,
offline, and unsupported choices cannot create sessions.

This increment executes in the selected worker's shared task workspace itself.
The client supplies an opaque workspace ID, not a filesystem path. It does not
provision a machine or start a replacement Host. This action explicitly selects
native **Folder** isolation, not the Host's Git-workspace **Worktree** default,
so execution stays in the chosen folder. Other supported native configuration
defaults are preserved; creation does not send an initial prompt or bypass
native tool approvals. After creation, use the existing Host panel to choose a
model, send, watch live output, or cancel the exact active turn.
An acknowledged empty native chat can retain lifecycle `creating` until its
first explicit send. A confirmed creation/binding is not a claim that the model
runtime has initialized, and Task Continuum never sends a warm-up prompt.

The worker saves a durable operation before invoking native creation. After
confirming the native session and chat identities, it saves that task's immutable
binding operation and private owner receipt. The caller then saves only the
matching task binding under its own revision check. Other bindings are not
overwritten. Binding publication uses the same Automatic workspace links path
as other configuration edits; it does not stage unrelated task or code changes.

If a connection drops, reopen the creation controls and check the saved operation.
Recovery queries the same operation; it never retries native creation or user
messages automatically. **Created but not bound** keeps the exact created session
available for an explicit binding retry after resolving a conflict. That action
only retries binding, not creation. A completed operation does not silently
restore a binding that was later detached. Private creation/status operation
records remain outside Git and do not grant access after send permission is removed.

Creation operation records require `schemaVersion: 2` and logical session
identities. Missing versions, Host-pinned session identities, mixed-format files,
and unknown versions are rejected. Unsupported records are not migrated,
discarded, or replayed.

Worker discovery checks these records before offering creation. A connected worker
with unreadable or unsupported records is shown as **blocked**, with a specific
diagnostic instead of a generic uncertain-outcome error. Update both desktops to
receive this readiness check and diagnostic. Repair or explicitly
initialize the worker's records only after backing them up; this is not automatic
migration. Existing uncertain caller operations remain uncertain: fixing the
worker's storage is not evidence that those operations never created a session,
and does not authorize discarding or replaying them.

### Native VS Code Controls

Task Continuum preserves the selected native harness's advertised capabilities;
it does not migrate a Local conversation or transfer its tools and configuration.
If a handoff is performed separately in VS Code, verify and explicitly bind the
resulting Host/session/chat. Never reuse the old Local identity as an AHP identity.

| Control on B | Copilot / Agent Host behavior |
|---|---|
| Agent / Plan | Native role selection remains available. Task Continuum does not change the Host's role or customizations. |
| Model | The native picker remains available for models supported by that harness and account. Sending retains the Host-advertised model/config and custom-agent selection; explicitly cleared draft selections use provider defaults. |
| Configure Chat | Native customization and permission controls remain on B. Legacy profile-only instructions are not guaranteed to be discovered by the Host. |
| Configure Tools | Copilot uses **Configure Chat -> Tools**, or **Chat: Open Customizations -> Tools**, rather than Local's request tool picker. Client tools can be enabled or disabled; Copilot's built-in tool entries are read-only in that configuration page. |

Task Continuum's composer **Model** picker uses the original provider's enabled
catalog and sends the requested model explicitly. **Model options** come from its
`configSchema`; enum, number and boolean types are preserved across the paired
gateway. **Default** omits an override rather than copying an unsynchronized
editor selection. A changed or unavailable model/option blocks sending until
corrected, and an older gateway is rejected rather than silently dropping config.
Options stay in the open panel only; recorded requested model/configuration and
history remain private, never workspace Git settings. See
[model selection details](../README.md#agent-host-sessions).

Client-provided tools require the contributing VS Code client to remain connected.
Closing B's editor does not guarantee those tools remain usable through Task
Continuum. The current [Copilot limitations](https://code.visualstudio.com/docs/agents/run/agent-harnesses#_copilot)
also restrict MCP transport/authentication support; verify required servers rather
than assuming that the entire Local tool list transfers unchanged. Tool availability
does not bypass native approvals. This release does not duplicate these settings
or proxy tool approvals in Task Continuum.

References: [session controls](https://code.visualstudio.com/docs/agents/run/agent-harnesses#_understand-the-session-controls),
[Copilot tool configuration](https://code.visualstudio.com/docs/agents/run/tools#_select-tools-for-a-request),
and [Host/client tool ownership](https://code.visualstudio.com/docs/agents/concepts/agent-host#_self-contained-with-optional-client-tools).

### Screenshots and Images

Paste a screenshot or choose **Attach images** in the native chat composer.
Up to four PNG/JPEG/GIF/WebP images can accompany a message, including image-only
messages, with limits of 5 MiB per image and 10 MiB total. The paired route sends
image bytes, not client filesystem paths. Previews/removal and failed-send draft
retention follow the [image attachment guidance](../README.md#image-attachments).
Images and history remain off Git; native model/tool capabilities and approvals
still apply. An interrupted image submission is not replayed automatically.

### Access and Recovery

The session-stream gateway accepts only initialize, snapshot recovery, ping,
allowed subscriptions and guarded send/cancel for the pinned chat. It rejects
root/other-chat subscriptions, filesystem access, arbitrary tools, arbitrary Host
configuration and raw session creation.
The separate device creation/status/bind commands are restricted to the paired
worker's existing send-scoped workspaces; they do not forward arbitrary AHP RPCs.
Native endpoints remain under `/device/agent-host/*`. The authenticated
`/device/identity` handshake checks device liveness and identity pins; it is not
a session catalog or a substitute for session authorization.
The native session summary excludes sibling chats. Terminals must be referenced by the
selected chat and retain its session/chat ownership. Changes to workspace policy
revalidate active sockets immediately; each outgoing batch and control also checks
the current policy and local owner receipt. Disconnect/Stop in **Remote devices**
stays authoritative.

Reconnection refreshes **state**, not execution. Delivery UUID/hash records are
persisted before dispatch; uncertain outcomes survive desktop restart and are never
resent automatically. Busy/queued/owner-draft states block sends. Offline history
comes from a bounded private cache, not Git, and never grants control.

The stable chat identity is `(owner.clientId, sessionId, chatId)`. The owner resolves
that identity against current trusted local Hosts on each new connection, verifies
the `copilotcli` provider, session snapshot and visible chat membership, and connects
only when exactly one Host matches. No match or multiple matches fail closed.
Host instance IDs, process IDs, endpoint tokens and addresses stay in discovery;
bindings, receipt identities, UI keys, offline caches and delivery keys do not
depend on them. Host restarts do not rewrite bindings or receipts, bypass
owner/workspace authorization, create a replacement session, or replay messages.
Native creation still explicitly selects a running Host. Its saved operation
retains that original creation intent for audit and replay prevention; the resulting
session identity does not retain the instance ID.
Legacy Local chats are not Agent Host chats: starting a Host does not make their
original runtime available through AHP. No Local migration is performed.

Native VS Code Copilot session resources use `copilotcli:/<id>` and a default
`ahp-chat://default/<encoded-session>` chat, not the PoC's manually chosen
`ahp-session:/<id>`. Both session formats are accepted with exact verified chat
membership. This build lists only the verified `copilotcli` provider.

### Local link receipt recovery

Only schema v2 is accepted. The file is an object with `schemaVersion: 2` and a
`receipts` array. Each entry has `root`, `taskId`, `owner` and an `identity`
containing exactly `sessionId` and `chatId`. Bare arrays, `hostId`, old Local
identities (`nativeSessionId`, `workspaceStorageId`), mixed files and malformed
data block access. There is no compatibility mode, migration or filtering.

This is a breaking upgrade, not a receipt-only migration:

1. Update both desktops and fully quit them before explicitly resetting any
  private state. The default Windows profile is `%APPDATA%\Task Continuum`;
  `TASKCONTINUUM_DATA_DIR` selects another profile for development.
2. Use fresh Automatic workspace links metadata for v2 bindings. Existing canonical
  logs containing old binding payloads are rejected. Do not modify signed records,
  delete individual operations from an accepted store, or import old authority.
  Archive any retired enrollment out of band and initialize a new workspace
  metadata set rather than treating a corrupted history as an empty store.
3. Explicitly remove an obsolete `local-session-link-receipts.json`, or reset it
  to `{ "schemaVersion": 2, "receipts": [] }`, only after all desktops using that
  profile have stopped. Preserve already-valid v2 receipts. Never remove `hostId`
  from an old receipt and claim that the result is newly authorized.
4. Old private creation records and old delivery/cache records are not imported.
  Retire them explicitly if needed; do not replay any uncertain operation or
  message from them. The application does not reset these records automatically.
5. On the owner, link the existing native chats again through **Agent Host sessions**.
  For a v2 binding already saved without its receipt, **Review session link**
  confirms the same chat and restores history/models without clearing its draft.

Cleanup removes obsolete authorization metadata only. It does not authorize a
session, create a chat, detach a task or modify immutable binding history. Do not
delete the entire profile, device keys or VS Code chat history.

Choosing a session belonging to another task only navigates to that task; it does
not confirm its access on your behalf.

The separate **Enable Automatic workspace links** error means the immutable
binding backend is not ready. Enable it under **Remote devices > Automatic
workspace links** for the selected workspace before linking. Receipt cleanup
does not bypass that requirement or create a session.

### AHP Verification Scope

Existing AHP checks cover Editor Host handshake/ping and an isolated Host reached
through the production paired SSH gateway. Fixed Host-local commands exercise both
Task Continuum and an independent owner-side AHP client, output before completion,
connection reuse and revocation without stopping the Host. Deterministic stream
checks cover passive owner-originated turns, snapshot recovery without sending,
native model/custom-agent preservation and reset, and owner-draft protection.
Sandboxed Electron checks cover discovery/link, both turn origins, retained drafts,
reconnect/restart and 420px layouts. Opt-in flags and scope are documented in the
[AHP proof of concept](../README.md#isolated-ahp-proof-of-concept).

The native test uses two fixed local commands, not model generation or a native
VS Code UI tool invocation. Real Copilot-generated text, required extension/MCP
tools, model/tool authentication and physical A/B cloud latency remain separate
gates. No user Local chat, current window, native configuration or binding is
automatically changed by these checks.

## Remote Devices and Workspace Links

B's Task Continuum desktop must remain open to host the managed transport, and
the original Agent Host must remain running. Closing B's desktop disconnects
remote clients without stopping the Agent. A needs no Copilot CLI sign-in.

Use **Remote devices**, not a session-specific sharing dialog. **Automatic
workspace links** exchanges signed public identities and recipient-bound
invitations among enrolled devices through the workspace's existing tracked
upstream. An invitation issued by X to Y enables **Y -> X**. Private device
invitation material is exchanged only inside authenticated SSH, not Git.
Enable the immutable backend with native consent on existing B/C before enrolling A.

Enable **Automatic workspace links** on both desktops and wait for the peer to
show **linked** and **connected**. Device pairing and private invitation exchange
are automatic; there is no manual pairing, file import/export, recipient selector
or **Enable linked sessions** step.

Active enrolled devices receive read and send access to the shared workspace's
locally confirmed sessions, including explicit **Create and assign**. Write access
is sufficient for association; there is no separate link permission or read-only
selector. Saved read-only grants for these enrolled peers are upgraded during
reconciliation, including after restart, without granting other workspaces access.

Enrollment does not create a session or send a prompt by itself, approve tools,
grant OS shell access or replace a local owner receipt. It still requires enabling
Automatic workspace links for bindings. Pause, disconnect and **Revoke automatic
link** remain available; revoked devices are not reauthorized. Existing enabled
pairs can continue independently of another offline device.

### Immutable Binding Synchronization

Public data is the `.taskcontinuum/workspace.json` descriptor plus immutable
signed, hash-addressed operations under `.taskcontinuum/records/v1`. Only four
public record types exist: **device**, **invitation**, **binding** and **setting**.
A v2 binding requires `provider: "agent-host"`, `sessionId`, `chatId`
and a stable owner (`clientId`, `machineName`). Ownerless and retired provider
formats are unsupported even inside signed records or SSH notifications.

The cadence is fixed at **15 seconds**. Configuration edits durably save their
operation and immediately schedule Git publication. Binding changes also notify
affected SSH peers immediately with the exact signed operation and bounded
dependency closure. B validates a provisional operation and requests an immediate
pull; it removes that overlay only when the **exact operation** is present in
validated canonical Git data. A successful pull before the publisher's push does
not confirm it. Descendants and concurrent operations use the normal resolver.

Provisional values have a 60-second lifetime. Expiry/restart leaves an explicit
awaiting-sync marker and disables the binding, rather than reactivating an older
route. Restore the publisher/upstream and synchronize the original operation.
Conflicting heads remain visible; ambiguous bindings are disabled. A canonical
session cannot be actively claimed by two tasks. Resolve conflicts with an
explicit binding/detach at the current revision, not by deleting record history.

The old `session-bindings.json` and workspace `localStorage` bindings are not read,
migrated or written. Existing files are left untouched; there is no migration UI
or IPC. Unsupported private store metadata/receipts are reported, never reset
or imported. Session history, model/options, private keys, tokens, private
invitations and owner receipts remain off Git. The immutable store's configuration
outbox is not an offline prompt queue.

See [workspace Git synchronization](workspace-git-sync.md) for enrollment,
configuration editing and recovery, and [task-document validation](task-documents.md)
for the read-only public-record checker. A consistency check is not local trust
or session authorization.

## Managed Dev Tunnel + SSH

### Transport requirements

- Install the [official Microsoft Dev Tunnel CLI](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started)
  once on A and B. The dialog opens that installation guide if the CLI is missing.
  **Sign in with Microsoft** uses the CLI's browser-based work-account flow; no
  password, device code, or access token is entered into Task Continuum.
- Sign in as the **same Microsoft work-account owner** on both machines. The
  managed route accepts only owner-private tunnels, not anonymous, tenant-wide,
  group-shared, or cross-owner access. Organization network and service policies
  still apply. Both ends use outbound relay connections; no inbound public IP or
  manually mapped port 22 is needed.
- Task Continuum creates separate host and client Ed25519 identities protected by
  OS secure storage. It hosts a loopback-only SSH server inside the app and uses
  the official Dev Tunnels SDK for the cloud connection. No shell, exec, SFTP,
  arbitrary destination forwarding, OS SSH account, or OS service is provisioned.
  Existing OpenSSH services, firewall rules, and user SSH files remain unchanged.
- Each device invitation pins the host and recipient public keys. The pairing ID
  is the SSH username, authorized only for the private gateway port. Exact native
  session and workspace checks remain enforced after SSH encrypts traffic across
  the relay.
- Device-key export is reusable; each native binding still requires the approved
  workspace policy and local owner receipt. This removes manual SSH configuration;
  it does not implement a central ten-machine registry, group policy, or SSH CA.
- Dev Tunnels is a preview service for development/testing with no production SLA.
  It is transport, not a durable message queue or ownership authority. Connection
  recovery never implies prompt replay or execution takeover.

## Windows Sign-in Recovery

Microsoft sign-in uses a temporary **Task Continuum Microsoft sign-in** console on
Windows. Complete the native account or browser verification when requested; the
console closes after login. It is not a terminal that must stay open for SSH. Cancel
and the five-minute login deadline terminate only the app's own login process tree.
Other CLI operations remain hidden, and no authentication output enters the renderer.

The app verifies the resulting company identity before enabling publication.
Preserve unsent drafts before restarting Task Continuum; do not reload the current
VS Code conversation for a Dev Tunnel login error. If sign-in is stuck, cancel the
pending login before signing in through the official
CLI with `devtunnel user login --entra --use-browser-auth`. Then choose **Refresh Dev
Tunnel status**. A verified external sign-in clears a stale login failure in the
desktop; an unrelated publication error is not hidden. Do not repeatedly
start competing logins or reset device keys to solve a sign-in problem.

## Sending and Disconnecting

- Select the exact bound task and explicitly send in **AGENT HOST**. Busy/queued
  work, an owner draft, uncertain delivery or invalid model options block sending.
  Read-only access cannot send or cancel; Stop requires send access and targets
  the exact active native turn.
- Replies and terminal output stream through AHP. Reopening or reconnecting obtains
  authoritative snapshots without resending. It does not wait for journal saves,
  move the conversation into a different runtime or substitute a new session.
- Native tool approvals, agent questions and provider sign-in remain on B. Device
  authorization does not proxy or bypass them.
- **Disconnect device** disables client connection recovery. Desktop shutdown or
  cancelling a connection closes only app-owned transport, not the Agent Host.
  Offline caches are bounded, read-only and never authorize a send.
- Revoking a device or removing workspace access rejects future reads/sends and
  closes affected connections. The local denial is effective independently of
  successful Git publication. Already accepted prompts and downloaded history
  cannot be recalled.

If B is unavailable, restore the approved device route and the same running Host.
Do not create a replacement chat, replace keys or resend an uncertain message to
make the UI appear connected. An unknown delivery remains blocked until its
original turn is observed. A replaced Host requires explicit verification and
binding of its existing session; desktop/network restart alone is not that change.

## Publication Lifecycle and Recovery

**Publish this machine** creates or reuses a private tunnel configured with
`--expiration 30d`; service expiry is independent of workspace/device access.
The app remembers the resource, a stable SSH port, and explicit publication
intent. Enabled publication resumes on desktop launch; older records without an
enabled flag remain opt-in. Only the app's single SSH port may exist on this resource.

**Stop publication** closes the cloud host and app SSH listener after native
confirmation. Closing B's desktop has the same transport effect, without stopping
VS Code or its Agent. Enabled device grants restore only with the authoritative
workspace backend and valid local pairing policy. Restart cannot turn unsupported
or revoked records into access. Transient cloud reconnection does not replay work.

**Cancel Dev Tunnel operation** cancels pending browser login or publication setup;
it does not stop an already running publication. Each pending remote connection has
its own cancel control. Setup and CLI calls have bounded deadlines and errors do not
contain cloud access tokens. No indefinitely running terminal is required.

For an expired/deleted tunnel, a changed account, or an unavailable saved port,
use **Reset saved publication** in B's device controls. Confirm the disconnection,
then sign in as the intended owner, publish again, and refresh device invitations
for the changed route through the approved pairing flow. Reset removes only the
local publication record; it preserves device keys and the original Agent.
The previous cloud resource remains owner-managed until its configured expiry.
No unknown process is killed and no port, account, or firewall policy is changed.

Wrong client key or lost profile: export this desktop's own identity and ask B to
enroll it again. Unavailable secure storage or a corrupt key fails closed rather
than saving plaintext or silently replacing identity. Unsupported sharing policy,
network denial, expired grant, busy Agent, or changed Host instance must be resolved
explicitly; none triggers an alternate Agent or weaker SSH verification.

## Storage and Trust

The four public immutable record types described above are the only Git
configuration authority. A hostname is metadata, not authentication; the original
Host/session/chat and stable owner are required. Signed remote data cannot create
a new local owner receipt, silently transfer ownership or bypass device trust.

Private desktop app data holds protected SSH keys, device invitations, enrollment
pins, owner receipts, delivery recovery state, configuration outboxes/overlays,
generated configuration editor state and bounded metadata-only caches. Git
synchronization uses the user's selected workspace checkout, not another clone
or worktree; app data contains no second copy of the AD task documents.
Generated views are not a second Git authority. Private invitations and all native
history, attachments, session model options and tokens remain outside version control
and unapproved cloud sharing.

The retained internal `RemoteVSCodeBridge` surface is limited to `devices`,
`devTunnels`, `gitSync` and `exportIdentity`. It provides no legacy per-session
invitation, catalog, history, read/send/open or grant APIs. Device filenames and
provider labels retain the existing identity and keys; they do not reinstate the
retired session manager. Legacy session metadata/cache files stay inert, never
read into session configuration or used for authentication or authorization.
Existing encrypted `sessions` and `known` fields remain opaque and unchanged;
historical session cache files are never loaded or deleted. The device host does
not resolve VS Code journals, and no automatic migration or deletion occurs.

Managed mode keeps `dev-tunnel-client-identity.json`, `dev-tunnel-host-identity.json`
and `dev-tunnel-publication.json` in the private profile. Private keys remain
OS-protected in their originating profile. Electron secure storage is required,
with no plaintext fallback. Dev Tunnel CLI account storage remains CLI-owned;
narrowly scoped cloud tokens are used only in main-process memory. The native
session endpoint token never leaves B or enters the renderer.

Changed fingerprints, malformed/unsupported records and mismatched owner receipts
fail closed, without deleting or replacing private identities or pending outboxes.
Explicitly review enrollment/trust policy for a genuine device-key replacement;
do not reset the key store to bypass an error. Replayed metadata cannot reinstate
a revoked device.

Native source history remains on B. A new client without a successful authorized
read has no offline history; downloaded caches never become execution authority.
Physical A/B/C connectivity, provider model/tool authentication and live Copilot
behavior require validation in the approved owner environment, independently of
the isolated AHP checks above.