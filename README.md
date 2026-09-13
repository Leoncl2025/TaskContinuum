# Task Continuum

A focused Electron workbench for tasks and the conversations that move them forward.
Familiar VS Code-style navigation, without an editor, extension host, terminal, or debugger.

**Local and shared-session MVP.** The desktop can connect to GitHub Copilot,
resume native CLI sessions, link an original VS Code conversation without forking,
or explicitly import reviewed text into a new Copilot session. It can also open real AgentDesk workspace folders as read-only
task views; the original sample workspace remains available as a separate demo.
A separate shared Host lets authorized participants converse with one owner Agent
over SSH, retain offline history, and continue reviewed checkpoints in an explicit
semantic fork. Git and OneDrive synchronization remain user-managed.

## What works

- Activity bar, task explorer, open-task tabs, task viewer, chat, and status bar.
- Search by task ID, title, or owner; filter by status; navigate a multilevel task tree.
- Parent-first task ordering, hierarchy guides, independent branch folding, and
    ancestor paths retained for filtered matches.
- Overview, requirements, plan, and acceptance checklist views.
- Local status/checklist edits with derived progress, and local demo task creation.
- Per-task conversations and drafts, streamed deterministic replies, cancellation,
  failure states, suggestion buttons, and scoped conversation clearing.
- Markdown assistant replies in local, shared, and original VS Code chats, with
    GFM tables/task lists, readable code blocks, and explicit code-text copying.
- Clipboard screenshots and image files in all chat composers, with previews,
    removal, image-only messages, and authenticated local/remote delivery.
- Independent desktop sidebar/chat toggles, compact single-pane navigation,
  keyboard quick-open, and dark/light appearance.
- Sandboxed Electron renderer with a minimal typed preload bridge.
- Real local Copilot authentication, model selection, new sessions, same-ID resume,
    streamed responses, tool activity, and cancellation.
- Searchable CLI/VS Code session lists, read-only transcript previews, and explicit
    import confirmation before continuing a VS Code conversation.
- Original VS Code task/session links, saved-history updates, and an authenticated
    companion extension that opens and sends to the original chat without forking.
- Original-session messages display the sender's username; replies include the
    actual execution machine. Delivery confirmation and tool approvals stay in VS Code.
- Remote original VS Code sessions over managed Dev Tunnel + SSH, with browser
    sign-in, encrypted device keys, explicit publication, scoped invitations,
    revocation, and private offline caches. Existing SSH aliases remain supported.
- Deny/allow-once tool decisions and agent questions, with pending requests cleaned
    up on stop, reload, or disconnect.
- Persisted native history, reviewed imports, and repository-backed task/session links.
- Native workspace folder selection, recent-workspace switching, and restart recovery.
- Real task metadata, statuses, requirements, plans, and acceptance criteria read from
    the selected AgentDesk folder; manual refresh picks up external file changes.
- Independent shared Hosts with distinct participant and execution identities,
    authenticated roles, serialized inputs, durable replay, and offline caches.
- Native OpenSSH forwarding, private invitations, owner-only Host stop/restart,
    and disconnecting a desktop without stopping the shared Agent.
- Reviewed checkpoint export, downloaded offline copies, and semantic continuation
    in a new session using an independent clean checkout and the recipient's account.

## Requirements

- Node.js 24 LTS and npm. Verified with Node 24.14.1 and npm 11.11.0 on Windows.
- Internet access for the initial dependency and Electron runtime download.
- A graphical desktop for Electron smoke tests. Offline tests need no model account.
- Real chat requires an authorized Copilot account and network access to its service.
    The official SDK 1.0.13 includes runtime 1.0.83 and reuses local authentication.
    Sign in directly through the Copilot CLI when required; never put tokens in the UI.
- Managed original VS Code access requires the official Microsoft Dev Tunnel CLI,
    the same Microsoft work-account owner signed in on both machines, approved
    outbound connectivity, and OS secure storage. The app manages its own restricted
    SSH endpoint; no OS SSH server, port 22 mapping, account, or SSH alias is required.
    Dev Tunnels is a preview development/testing service without a production SLA.
- The optional SSH-alias mode and separate shared CLI Host still require system
    OpenSSH, an independently configured owner SSH server, public-key authentication,
    and a verified host key. No user SSH configuration or firewall rules are changed.

## Run and verify

Run commands from this repository's root. Dependencies are pinned in
[package.json](package.json) and [package-lock.json](package-lock.json).

| Command | Purpose |
| --- | --- |
| `npm ci` | Install locked dependencies and the Electron runtime. |
| `npm run dev` | Start the Electron application with renderer hot reload. |
| `npm run dev:web` | Preview the demo browser UI at http://127.0.0.1:5178; native session operations require Electron. |
| `npm run typecheck` | Check main/preload, browser, and test environments separately. |
| `npm run lint` | Run ESLint with no warnings permitted. |
| `npm test` | Run unit and React component tests. |
| `npm run build` | Type-check and build production main/preload/renderer output. |
| `npm run build:vscode-bridge` | Type-check and package the local original-chat companion VSIX. |
| `npm start` | Open the already-built Electron application. |
| `npm run check` | Run lint, unit tests, and production build. |
| `npm run test:e2e` | Build and run real Electron tests; live model calls are skipped unless explicitly enabled. |

Electron 44 exposes an explicit `install-electron` command instead of a package
`postinstall` script. This project's `postinstall` runs that installer automatically.
If install scripts were disabled, or an older checkout reports `Error: Electron
uninstall`, run `npx --no-install install-electron`, then retry `npm start`.
`npm rebuild electron` alone does not invoke the installer in this version.

The Electron development renderer uses port 5177; browser-only preview uses 5178.
Both bind to loopback and fail rather than silently changing ports. Stop an existing
preview if its port is already occupied.

Desktop tests use the installed Electron executable, not a downloaded Playwright
browser. Their isolated profiles, screenshots, and reports are ignored by Git.
Screenshots cover dark, light, contextual chat, and compact layouts.

## Agent Host Sessions

Existing **Agent Host-owned** Copilot chats now use the official AHP 0.9.0 client
instead of the VS Code Companion. Open **Agent Host sessions** in the activity
bar, allow local Host access for the selected task workspace once, and link the
existing chat. No session is created, imported, forked, or resumed through the CLI.
The Host and its signed-in provider must already be running.

For another desktop, reuse **Remote VS Code sessions > Devices** and its existing
private Dev Tunnel + restricted SSH pairing. B links the chat once; after Git
synchronizes the link, A selects the task. No new tunnel port, per-session invitation,
Host-wide credential, or Companion extension is required for this AHP route.
Workspace read/send policy and B's local confirmation receipt remain mandatory.

The chat panel shows live Markdown, reasoning/tool status and terminal output,
supports pasted images and exact-turn cancellation, and retains drafts during
updates/reconnection. Native tool approvals, questions and provider authentication
remain on B. Recovery obtains authoritative snapshots; it never replays a send.
An unknown delivery blocks further sends until its original turn is observed.
Read-only participants cannot send or cancel.

Choose **Model** immediately above the Agent Host message input before sending.
The picker stays beside the composer rather than at the top of the chat panel.
Loading errors and the **Retry loading models** button appear there too; retrying
preserves your draft and never sends it automatically. The list comes from the
original Host's provider, excludes policy-disabled models, and is scoped to that
provider when shared through a paired device. Task Continuum sends the selection
explicitly, including through the remote gateway; it does not assume the VS Code
input picker has synchronized its draft. Native model changes do not overwrite
your selection while this panel is open. Reconnect refreshes the list, and an
unavailable model blocks sending rather than silently falling back. Each recorded
turn shows its requested model ID, not a guarantee of the provider's actual model.
Both desktops need this update for remote model selection; an older owner gateway
is rejected with an update message. Model selection does not change native tool
approvals or create a new conversation.

**Model options** beside the composer are generated from the selected model's
Host-provided `configSchema`, including Thinking Level and Context Size when
advertised. Enum labels come from the Host; numeric and boolean values retain
their types through IPC and the paired gateway. **Default** omits that override
and uses the Host's default (not the native editor's unsynchronized selection).
Switching models clears overrides; reconnecting retains them, but changed or
removed options block sending until corrected or reset to defaults. Read-only
options cannot be changed. Configuration is checked again against the current
catalog before dispatch. Update both desktops for remote configuration support.
Each turn records its requested config for inspection. Options are retained only
while the panel stays open, not across application restarts.

Git stores a distinct `agent-host` provider with owner Client ID, Host instance ID,
session URI and chat URI. Native Copilot sessions use `copilotcli:/...` and
`ahp-chat://default/...`; the prototype's `ahp-session:/...` form is also accepted.
Only the verified `copilotcli` provider is currently listed. The link contains no
endpoint token, route or history. Host
instance identity is pinned: replacing/restarting that Host does not silently select
a different process; explicitly verify and relink its existing session if needed.
Existing extension-host **Local** links continue through the legacy Companion,
unchanged. AHP cannot subscribe to those Local conversations or preserve their
runtime by starting a new Host. See [the remote runbook](docs/remote-vscode.md#agent-host-ahp).

### Isolated AHP proof of concept

The opt-in [AHP test](e2e/ahp.spec.ts) uses the official
`@microsoft/agent-host-protocol` runtime client and an actual standalone VS Code
Agent Host. On Windows with VS Code 1.137 installed, run:

```powershell
$env:TASKCONTINUUM_VERIFY_AHP_CLI = 'C:/Program Files/Microsoft VS Code/bin/code-tunnel.exe'
try { npx playwright test e2e/ahp.spec.ts }
finally { Remove-Item Env:TASKCONTINUUM_VERIFY_AHP_CLI -ErrorAction SilentlyContinue }
```

The test starts a new loopback-only, token-protected Host with temporary data
directories, downloads its matching server runtime if needed, and closes only its
own processes afterward. Two observers and the production `AgentHostConnection`
share one session/chat; one observer connects through real local SSH. A fixed
`!node output.mjs` command sent once by production code generates Host-local chat/tool
events and incremental terminal output, followed by subscriber disconnection and
sequence-based replay. It checks unchanged unrelated chat state and one execution.
The CLI may write its normal supervisor log outside the temporary directories.

Verified protocol: **0.9.0**, advertised provider: **copilotcli**. No model generation
is requested. This proves the AHP subscription/recovery path, not Copilot-generated
`chat/delta`, physical A/B latency, or access to existing extension-host Local
sessions. The production AHP route is covered separately by
[the desktop test](e2e/agent-host-desktop.spec.ts) and paired-device SSH regressions.
No live Copilot model or physical A/B cloud result is inferred from these tests.

On an already running VS Code 1.137 Editor Host, the opt-in
`TASKCONTINUUM_VERIFY_AHP_LOCAL=1 npm test -- test/agent-host.test.ts` verifies
read-only discovery, authenticated named-pipe/TCP handshake and ping. It sends no
model prompt and reads no conversation content. The actual runtime exposes
`agenthost-terminal:` resources as well as the documented `ahp-terminal:` scheme;
both remain restricted to terminal references owned by the linked chat.

## Chat Markdown

Assistant replies use the existing `react-markdown` and `remark-gfm` stack instead
of displaying Markdown source as plain text. Headings, emphasis, inline code,
lists, disabled task checkboxes, quotes, strikethrough, and tables are rendered.
Single line breaks remain visible. Code blocks show their language and a **Copy
code** action; long code and tables scroll within the message, including narrow
Chat panels. User messages and delivery receipts retain their original literal text.

The same renderer handles local/CLI output, shared live or cached replies, and
original VS Code saved history. Updated text is rendered again, including an
unfinished code fence; unchanged replies avoid repeated parsing while composing.
It does not change source history, native session IDs, or synchronization latency.

Messages are untrusted content. Raw HTML is omitted, links remain inert text,
and Markdown images show their alternative text without making external requests. Copying
writes only the code text through a trusted-window, 1 MiB-limited desktop API;
background clipboard reading and general browser permissions remain unavailable. Browser
preview uses the browser's clipboard permission and reports a failed copy.
Math, Mermaid diagrams, syntax highlighting, and VS Code editor/diff actions are
not part of this renderer. The inspected
[VS Code chat Markdown implementation](https://github.com/microsoft/vscode/blob/645f29cc3176500b4b5762ba887cf2a7f0ffdf2c/src/vs/workbench/contrib/chat/browser/widget/chatContentParts/chatMarkdownContentPart.ts)
uses a separate Markdown pipeline with GFM, line breaks, code-block rendering,
sanitization, and scrollable tables. No VS Code installation changes are needed;
load the updated Task Continuum desktop and preload to use this display fix.

## Image Attachments

Paste a screenshot with Ctrl+V (Cmd+V on macOS), or choose **Attach images** in
the composer. Preview or remove thumbnails before sending. Text is optional.
PNG, JPEG, GIF and WebP are accepted: up to four images, 5 MiB each and 10 MiB
per message. Invalid or oversized images leave the existing draft unchanged.
Reading finishes before Send becomes available; failed submissions retain the draft.
Ordinary text paste is unchanged. No background clipboard access is requested.

Local Copilot and shared CLI sessions send native SDK blob attachments. Original
VS Code sessions require Companion 0.5.0 on the execution machine: image bytes
travel over the existing authenticated connection, are stored privately there,
and their file references are included in the exact original Agent's prompt.
This route requires an image-reading tool in that Agent; it does not inject
VS Code's native image-variable UI or bypass tool approval. Session, Agent and
model identities are retained, including when the sender is on another machine.

Original/shared image stores use content hashes, integrity checks and a 256 MiB
limit per store. Delivery and shared event journals contain metadata, not base64.
Original/shared synced history and checkpoints carry attachment metadata only;
full-size previews use images retained in the current desktop view. Image files
are not copied into Git or checkpoint forks. Drafts remain in memory and follow
the existing composer lifetime; restarting the desktop discards unsent drafts.
Reload both desktops and the updated Companion after preserving active work.

## Open a task workspace

1. In the desktop explorer, choose the folder icon labeled **Open workspace folder**.
    The title-bar folder icon is also available when the sidebar is hidden.
2. Select the workspace root, for example `Q:\src\Projects\TaskContinuum-ad`,
    not its `tasks` subdirectory. The root must contain `.agentdesk/config.json`.
3. Use the **Workspace** dropdown to switch between recent folders or return to
    **Local demo workspace**. The selected folder is restored after restart.
4. Use **Refresh workspace** after editing task files in VS Code or another tool.

Real task views are read-only: task creation, status changes, and checklist toggles
remain demo-only until a reviewed write-back workflow is implemented. Opening a
workspace does not change any planning files or execute instructions found in them.
Explicit session link and unlink actions write only the relationship metadata
described below; they do not change task JSON, status, or acceptance documents.
Markdown is rendered without active links, external images, or HTML execution.
Invalid tasks and unavailable documents are reported in the explorer's warnings.

Workspace switches reset task tabs and unsent drafts. Each workspace owns its
relationship file, so identical task IDs in unrelated folders do not share links.
Cloning a workspace carries its checked-in links without carrying a machine path.
Stop active responses before switching. New Copilot sessions
default to the selected workspace; imported conversations retain their reviewed
source directory unless a different directory is selected explicitly.

Read limits are 1 MB per task/document file, 16 MB per workspace load, and 1,000
task directories. The configured task path and resolved filesystem links must stay
inside the selected folder. Recent-workspace state is stored atomically in the
desktop profile's `workspaces.json`; no task contents are cached there.

An explicit launch folder is also supported:

```powershell
$env:TASKCONTINUUM_WORKSPACE = 'Q:\src\Projects\TaskContinuum-ad'
npm start
Remove-Item Env:TASKCONTINUUM_WORKSPACE
```

## Continue a local conversation

1. Run `npm run build` and `npm start`, then choose **Local sessions** in the desktop.
2. Select **Connect Copilot**. The account and runtime status reflect the actual SDK connection.
3. For a CLI conversation, stop activity in its original client and choose its **Resume** entry.
    The original session ID and native history are retained.
4. For VS Code history, open **Preview**, review the exact text and working directory,
    choose **Import into new session**, then **Continue in new session**. The first
    message carries the reviewed context. To keep the original session, use the next section instead.
5. Send a message. Review tool requests with **Deny** or **Allow once**, or use **Stop response**.

VS Code import is a text-history handoff, not control of an active VS Code Chat process.
It does not transfer attachments, tool results/state, pending edits, or hidden reasoning.
Import itself makes no model request and never changes the source file. Legacy JSON
and JSONL history files have no application-imposed file or record byte limit.
JSONL is read in chunks and replayed one record at a time. The most recent
60,000 text characters/500 messages are previewed,
with truncation and unreadable-source warnings shown explicitly.

Removing history byte limits does not guarantee unlimited memory: each JSONL record
and legacy JSON file is still assembled and parsed in memory, subject to runtime
string and memory capacity. Workspace metadata, display/transport payloads, and
attachments retain their separate validation; source history is never truncated.

To opt into three small authenticated model requests that verify creation, restart
continuity, and imported context:

```powershell
$env:TASKCONTINUUM_LIVE_COPILOT = '1'
npm run test:e2e
Remove-Item Env:TASKCONTINUUM_LIVE_COPILOT
```

The live test sends only synthetic prompts and a synthetic transcript, not your
existing conversations. Requests can consume Copilot usage. Normal tests remain offline.

## Link an original VS Code conversation

This path keeps the original GitHub Copilot Chat session ID. It is not a fork or
text-history import. Task Continuum sends explicitly submitted messages to that
session and displays its saved responses. **Delivery confirmation is enabled by
default and can be disabled; stopping responses, answering agent questions, and
approving tools still happen in VS Code.**

1. Open the task workspace in Task Continuum and select the target task. Open
    **Sessions**, choose a **VS Code history** entry, then **Link to current task**.
    No CLI sign-in is needed to link or view saved history. If the task already has a
    different link, detach it first; this does not delete the underlying conversation.
2. Build the companion with `npm run build:vscode-bridge`. Install the resulting
    `artifacts/taskcontinuum-vscode-bridge-0.5.1.vsix` through VS Code's
    **Extensions: Install from VSIX** command. Component details are in
    [vscode-bridge/README.md](vscode-bridge/README.md).
3. In VS Code, open the conversation's original workspace, which may differ from
    the task repository. For example, a conversation created in `Q:\src\Projects`
    needs that VS Code window, not a new window opened only on TaskContinuum-ad.
4. In Task Continuum's linked panel, choose **Connect VS Code**, then confirm
    **Connect** in the original VS Code workspace. The bridge starts without sending
    a message or creating a conversation. Companion 0.4.1 remembers this workspace
    and automatically restores the Bridge after VS Code startup/reload. **Stop VS
    Code Bridge** disables that restoration. Existing installations need one explicit
    connection after upgrading. **Open in VS Code** remains available as
    the external-link icon. The Command Palette's **Task Continuum: Start VS Code
    Bridge** command is still available for manual startup.
5. Sign in to Copilot in the original VS Code workspace with its existing Agent
    mode and an available model. Finish any active response and clear its unsent
    draft. Enter a message in the desktop and choose **Send to original VS Code
    session**. The app restores the approved connection and opens the exact original
    chat only if needed, verifies it, then submits once. No separate Connect or Open
    click is required. If delivery confirmation is enabled, review the exact target,
    username, machine, and message in VS Code, then confirm **Send to original
    session**. Otherwise the desktop submission sends directly. No CLI session is created.
6. **Detach conversation** removes only the task link. **Task Continuum: Stop VS Code
    Bridge**, reloading, or closing the VS Code window ends its delivery service;
    closing the desktop does not cancel the VS Code Agent.

Failed delivery rows offer **Remove failed message from this device**; the panel
toolbar offers **Clear failed messages from this device**. Removal is a local view
preference, saved per original session and owner machine across desktop restarts,
including offline remote views. Only failed receipts are hidden: pending/uncertain
deliveries still block sending, and native messages and later confirmed outcomes
remain visible. Draft text/images, B's delivery journal, and deduplication records
are not deleted or replayed. Other desktops keep their own view preferences.
This feature needs the rebuilt viewing desktop, not another companion upgrade.

After upgrading the companion, finish active work and reload its VS Code window
if the old extension is still loaded, then start the bridge again. The desktop
never reloads VS Code or silently starts a new Agent for you.

Companion 0.5.1 removes the history byte limits at the user's request, rather than
replacing them with a larger fixed threshold. Version 0.4.4 had raised the JSONL
record cap to 64 MiB after a 43.1 MiB initial snapshot failed in a 44.2 MiB journal.
There is now no application-imposed record, total-journal, or legacy-history file
size cap. Record streaming, partial-tail handling, path validation, display bounds,
and no-replay behavior are unchanged. Runtime memory constraints still apply.
Load the rebuilt source-machine desktop and the updated companion after active work
ends, then refresh/reconnect the receiving desktop. A failed history can appear as
an offline cached session even while other sessions on the same device are connected;
it does not require a new fork or new device pairing.

Companion 0.4.3 combines connection, exact-view preparation, and one explicit Send.
Existing open views are left in place; preparing a closed original can change B's
visible chat. Browsing tasks never opens a view, and optional Open controls remain
available. Preparation failures retain the desktop draft without a send queue or
automatic replay. First workspace consent, pairing, and native tool approvals are
unchanged. Both desktops and B's companion must load the updated build.

The 0.2.6 reader fixed long JSONL conversations disappearing from the session list.
Previously the 32 MiB whole-file import limit also applied to journal discovery and
original-session reads. That release introduced chunked record replay rather than
loading the whole journal into a string; 0.5.1 also removes its record/file byte caps.
List, preview, original history, and the companion use the same
reader. The most recently parsed file revision is reused until its identity, size, or
timestamps change; caller mutations do not alter the cache. Skipped files include the
specific read or format error. Existing session IDs, bindings, and source files are
unchanged. Reopen an older desktop to load the reader; load the updated companion
after active work ends for the same long-history support in the sending path.

Bridge 0.2.5 introduced optional extra-send confirmation. The current default for
`taskcontinuum.confirmOriginalSessionSend` is `false`, so messages send directly.
Set it to `true` in the execution machine's VS Code User settings to require the
popup; an explicit `true` remains enabled after upgrades. The setting takes effect
on the next message without a bridge restart. It is machine-scoped, so task
repositories cannot override it. Connection consent and Copilot tool approvals are
unchanged, as are original-session identity, trust, busy/draft checks, and no-replay
protections. The real installed-VS-Code test verifies explicitly confirmed delivery
followed by a distinct no-popup delivery, both targeting the same original session
without moving the sidebar or changing the other editor conversation.

Bridge 0.2.4 adds explicit cache invalidation through the contribution's own
`taskcontinuum.deliveryRevision` context condition after every template update and
restoration. It also checks a unique, non-sending handoff before starting the bridge.
The check only prepares and restores the private template; it does not send a prompt,
invoke an Agent, alter history, or create a delivery record. On failure, VS Code shows
the mismatch and the bridge does not start. Connect first; a user message is no longer
needed to discover a template-readiness failure. This does not validate model access.

The continued real-workspace failure on 0.2.3 was not resolved by its earlier isolated
tests. The latest verification covers no-message connection and two distinct deliveries
with file watching excluded, but does not certify the current user's unreloaded window.
Failed/pending user submissions remain untouched and are not automatically replayed.

Bridge 0.2.3 changes template identity matching after the custom-Agent cache has been
loaded. The template keeps a stable registered name and is updated through VS Code's
file service. A cached display name is not used as proof that a message is current:
the exact template file, unique command handoff, complete message, original Agent,
and auto-send flag must match. Timeout errors now name the failed condition without
printing message contents. No existing failed submission is retried automatically.
Verification includes two different consecutive messages in the same installed
VS Code window, with distinct native request IDs and unchanged conversation layout.

Bridge 0.2.2 removes automatic editor opening from the send path. Earlier builds
opened the original conversation as an editor immediately after confirmation,
which moved a sidebar conversation and left that sidebar empty, even if the later
delivery failed. Sending now targets the already-open original widget directly.
If that widget is unavailable, it fails without moving, creating, or substituting
a conversation. The separate **Open in VS Code** icon still explicitly opens as an
editor; it is not needed to send to a conversation already open in the sidebar.

To return a conversation moved by an earlier build, focus its editor tab and run
**Chat: Move Chat into Side Bar** from VS Code's Command Palette. This moves that
existing conversation; it does not delete history. No automatic layout reset,
window reload, or message replay is performed by the repair.

Bridge 0.2.1 adds the desktop connection entry. Reopen an older running Task
Continuum build to load the new button; finish or preserve any unsent draft before
restarting the desktop. Connection attempts within the same open panel keep its
draft. The input area states why sending is disabled: disconnected, unsupported
bridge, active response, pending/uncertain delivery, wrong mode, or an original draft.
Connecting does not override those guards. Readiness refreshes automatically.

Keep the source VS Code workspace window foremost when connecting. VS Code routes
extension URIs to its topmost window; a different workspace is rejected, not opened
or switched automatically. The restricted `vscode://taskcontinuum.vscode-bridge/connect`
URI (or `vscode-insiders://`) contains only the original session/workspace IDs. Its
handler checks the existing session and asks for connection consent; it accepts no
message, command, token, or caller-provided filesystem path.

Local messages display the bridge OS username; remote messages use the recipient
identity approved by the owner when granting access. Replies display
`Agent name @ execution machine`, supplied by B's bridge, not the renderer.
These are different from the `GitHub Copilot CLI` connection in the session explorer.
Remote bearer grants bind approved labels, not hardware-attested identities. Historical
authors/machines without evidence remain unknown, not assigned to the current user.
Recorded attribution survives restart and offline viewing; last-recorded identity
is explicitly distinguished from an online execution owner.

Delivery is persisted before dispatch and matched to the original native request
ID. Retrying a lost acknowledgment uses the same command ID. Unconfirmed deliveries
are never automatically resent, including after restart. The delivery journal is
limited to 500 messages/4 MB per source workspace. VS Code normally saves session
state about once a minute, so desktop confirmation/history can lag its UI; **Refresh
original conversation** rereads saved state and does not force a VS Code save.
Replies are a saved-history view, not a guaranteed token stream. `Submitted` means
the native request was found, not that its Agent finished. Check VS Code if a delivery
remains uncertain; do not submit a duplicate while its outcome is unknown.

The companion currently permits VS Code 1.136.x and 1.137.x local trusted workspaces;
the actual original-chat commands were verified with VS Code 1.136.1 and 1.137.0. Sending uses
`workbench.action.chat.executeHandoff` with an explicit original `sessionResource`,
a unique delivery item, and the original Agent mode. A temporary extension-owned
template provides the message, guarded by a cross-window lock and cleaned after
delivery; it is not the Agent executing your task. No focused-widget Send command
is used. Other versions, Remote SSH/WSL/container windows,
and virtual workspaces are unsupported until verified. There is no use of proposed
API enablement, focus-based Send automation, Copilot credential access, or automatic
approval. Missing sessions and missing/ambiguous bridges are reported rather than
falling back to a new CLI session.

This is a version-specific compatibility integration, not a supported public control
API. Do not change the original draft, mode, model, or conversation while delivery
is being confirmed; saved-state checks cannot fence concurrent live edits. Ambiguous
Agent names are rejected. If VS Code crashes, inspect the original request and confirm
the old process has stopped before removing a reported stale delivery-template lock.

The companion starts only on explicit command or confirmed connection. It exposes authenticated loopback
`GET /identity` and `POST /open`, `/send`, `/deliveries`, rejects browser origins, and confines delivery to
existing saved sessions in its own workspace. A per-run credential is stored under
VS Code's `User/workspaceStorage/<workspace-id>/taskcontinuum.vscode-bridge/bridges/`.
Private delivery records are in the parent extension-storage directory. Message
payloads briefly reside in the installed companion's ignored output template while
it is being delivered; normal completion/stop clears them, but a crash may leave a
private payload for manual recovery. These records stay outside Git and credentials
stay outside the renderer. Protect the local profile and trust
installed extensions; this credential does not defend against a compromised OS user.

Bindings include `provider: "vscode-copilot"`, the original `sessionId`, and
`workspaceStorageId`. Remote bindings also carry `remoteMachineName`, with private
invitations and SSH aliases stored separately in the desktop profile. Git alone
does not provide history or remote authorization. If Stable and Insiders both contain the same source identity,
select the intended data root with `TASKCONTINUUM_VSCODE_USER_DATA_DIR`.

## Remote original VS Code mode

Companion 0.4.1 lets A/C converse with the same original GitHub Copilot Agent in
B's local VS Code window. The default **Dev Tunnel + SSH** mode manages the relay,
device keys, and loopback forwarding inside Task Continuum, without terminal windows
or Windows SSH setup. It currently requires the same Microsoft work-account owner
on both ends; it is not a tenant-wide device registry or SSH certificate authority.

1. On A, open **Remote VS Code sessions**, sign in with Microsoft, and **Export client
    identity**. The file contains a public device key, not its private key.
2. On B, open the same device panel, sign in, choose **Linked-session access**, then
    **Pair device** with A's identity. Confirmation enables this AD workspace's linked
    sessions and starts publication automatically; no Session dialog or Publish step.
3. Transfer the private device invitation once and verify B's fingerprint. A uses
    **Import device invitation**, consenting to automatic connection for this workspace.
4. B links an original VS Code Session to a Task. The Git-managed link records its
    stable owner Client ID and machine name. B commits/pushes normally; A pulls and
    opens the Task. Owner routing reuses the device connection, without Share session
    or a second Link action. Open-workspace links refresh about every five seconds.

Existing device pairs can enable this policy with **Enable linked sessions**. Existing
owner-less links need **Register existing local links** on B, followed by a Git push.
The app validates the original locally and records private binding receipts; changing
Git alone cannot grant access to unrelated local histories. Git operations are manual.
The current device gateway supports original VS Code sessions. Foreign CLI-owner links
are not automatically resumed locally; the independent shared CLI Host is unchanged.

No Copilot CLI login is needed on A, and no conversation is created, resumed, imported,
or forked. The legacy **SSH alias** mode remains available on both dialogs.

To switch an unopened original remotely, select its linked Task on A, click the
external-link icon **Open session on B** beside the execution-machine name, and
confirm. B opens that existing chat as an editor; A refreshes and can submit a new
message separately. Read/send permission and the loaded 0.4.0 Bridge on B are required.
The action may change B's layout, but never sends automatically, replays a failed
prompt, changes ownership, or replaces the Agent. Native tool approvals stay on B.

On Windows, Microsoft sign-in opens a temporary **Task Continuum Microsoft sign-in**
console for the native/browser account flow and closes it afterward. Other tunnel
operations stay in the background. Earlier builds could remain at **Signing in**
when launched from Electron. Preserve drafts and reopen Task Continuum to load the
fix; **Refresh Dev Tunnel status** picks up an existing CLI sign-in and clears stale
login errors without publishing anything. VS Code does not need reloading for this fix.

See the [remote VS Code runbook](docs/remote-vscode.md) for both-machine setup,
access control, renewal, disconnect/offline behavior, and recovery. Enabled publication
recovers after network loss and desktop restart; **Stop publication** disables recovery.
Device pairing and workspace sharing policies persist encrypted for up to 30 days.
**Disconnect device** stops client recovery; no execution message is automatically replayed.
The old **Choose recipient / Import invitation** path remains session-scoped and needs
new invitations after Bridge restart or expiry. Neither path stops B's Agent.
B's account, tools, and native approvals remain on B. The app does not change
existing SSH services, firewall rules, or user private keys.
The separate **Shared sessions** feature below starts a CLI Host and is not this mode.

With an already signed-in, approved Dev Tunnel account, set
`$env:TASKCONTINUUM_LIVE_DEV_TUNNEL = '1'` in PowerShell, then run
`npm test -- test/dev-tunnel-manager.test.ts` and, after building,
`npx playwright test e2e/remote-vscode.spec.ts`. Clear the opt-in afterward with
`Remove-Item Env:TASKCONTINUUM_LIVE_DEV_TUNNEL`. These tests create and delete private
test tunnels; they do not send to a production Copilot Agent.

## Versioned task/session links

Real workspaces use `.taskcontinuum/session-bindings.json` in the task repository,
alongside `tasks/`, not in the application source repository or desktop profile.
The relation is a single source of truth keyed by task ID:

```json
{
    "schemaVersion": 1,
    "bindings": {
        "T-0002": {
            "provider": "github-copilot",
            "sessionId": "example-native-session-id"
        },
        "T-0003": {
            "provider": "vscode-copilot",
            "sessionId": "example-original-vscode-id",
            "workspaceStorageId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
    }
}
```

The example IDs are illustrative. Opening or creating a CLI conversation records
the native SDK session ID only after the repository write succeeds. Selecting a
CLI-linked task resumes that ID; a VS Code-linked task loads its saved original
history without calling the CLI. Selecting an already-linked session returns to its task.
The current MVP permits one session per task and one task per session in a workspace.
Detach an existing link explicitly before moving the session to a different task.
Session uniqueness includes its provider and, for VS Code, its source workspace
and optional remote execution machine (case-insensitive).
Existing CLI-only files remain valid. Older Task Continuum builds that understand
only CLI links cannot read the new provider variant; use this build on those clients.

Check in the relationship file and its generated `.taskcontinuum/.gitignore` with
the task repository. The ignore file excludes write locks and temporary files,
not the relationship document. No Git staging, commit, or push happens automatically.
Session IDs are metadata, not authentication secrets; review them before publishing
to a public repository. Titles, messages, imported transcripts, machine paths,
tokens, credentials, and runtime state are not included in this document.

Earlier versions stored links in workspace-scoped `localStorage`. If no repository
file exists, **Review links** lets you inspect the task/session IDs and explicitly
save them into the workspace. Migration is atomic and clears the old cache only
after success. An existing repository file, including an empty one, always wins;
opening a workspace never imports local caches or creates the file automatically.
Demo mode continues to use local-only bindings.

Writes validate the selected workspace and task, acquire an exclusive local lock,
compare the loaded content revision, then replace the file atomically. Conflicts,
invalid JSON, and Git merge markers are reported without overwriting the file.
Use **Reload session links** after resolving a conflict, or **Refresh workspace**
after external edits. A stale lock should only be removed when all app instances
that could be writing the file have stopped.

Git synchronizes the relation, not the session. Another machine still needs the
corresponding native Copilot history, a separately published shared Host, or an
explicitly imported private invitation for the recorded remote VS Code machine. Unavailable
sessions keep their repository link and are reported explicitly; the UI does not
silently create a new session or fall back to demo replies. Detach deletes only
the relationship entry, never the underlying conversation history.

## Share one execution Agent

Shared sessions are separate from the local-session list. Publishing starts a new
native conversation; it does not transfer a running VS Code or CLI process.

1. On owner machine B, open the task workspace and select a task. Open **Shared
    sessions**, then **Publish shared session**. Select the Agent's execution directory
    and **Live only** or **Live + checkpoint**. Use a dedicated checkout for execution;
    it can be separate from the planning repository. B must be signed in to Copilot.
2. Check in the generated `.taskcontinuum/shared-sessions.json` and its ignore rules
    with the task repository. A/C open a clone carrying the same workspace UUID.
    These are explicit file changes; the app never stages, commits, pushes, or pulls.
3. On A, select **Export participant identity** and send that identity file to B.
    On B, choose **Invite participant**, enter the SSH alias that A uses for B, select
    a role, then choose A's identity file. Securely transfer the resulting private
    invitation to A, outside Git. C follows the same enrollment flow.
4. On A, select **Join shared session**, choose the invitation, and confirm the
    trusted owner. The main process opens an SSH tunnel using the existing alias.
    A can subsequently use **Connect shared session** to replay missing events.
5. Messages show the participant's user and machine; replies identify B's Agent.
    A/B/C send to the same native session on B. The Host serializes accepted commands;
    contributor roles can send, operators can also approve, stop, and export, and
    readers can only view. Only the owner can invite or manage the Host.
6. **Disconnect shared view**, hiding the panel, or closing the desktop leaves B's
    Agent running. **Stop shared Host** stops it for everyone after confirmation.
    **Restart local shared Host** works only on its original owner/profile, retaining
    logical/native IDs and leaving unfinished commands interrupted, not replayed.

The versioned shared route stores workspace/logical session UUIDs, task ID, mode,
owner machine/Agent/native ID, epoch, and optional fork lineage. Its `active` map
identifies the published source for each task; independent forks do not replace it.
It contains no SSH credentials, tokens, transcripts, or execution paths. Legacy
`.taskcontinuum/session-bindings.json` entries without `remoteMachineName` remain
local-only; remote original VS Code links are separate from shared CLI routes.
Neither is promoted silently. Git merge conflicts and competing active routes
require manual resolution.

Enrollment is a bearer grant bound to exported profile identity, not hardware or
enterprise identity attestation. Protect invitations and the desktop profile.
SSH trust and session enrollment are separate permissions. Use a known host alias
configured for noninteractive key authentication; an unknown host key or password
prompt makes Connect fail with a setup error rather than weakening verification.

When B is unavailable, enrolled clients retain only their verified cached prefix.
A new client cannot retrieve live-only history from task metadata. Offline drafts
are not submitted automatically and do not survive closing the panel. Retrying an
unchanged message in the same panel reuses its command ID after a lost acknowledgment;
there is no persistent offline outbox. Reconnect explicitly after connectivity returns.

## Checkpoint continuation

1. In a **Live + checkpoint** session, finish or stop the current turn and resolve
    pending decisions. The execution repository must have a clean Git status.
2. Select **Export checkpoint**, review the conversation and export confirmation,
    then choose an approved destination such as an existing OneDrive sync folder.
    Local file creation does not confirm cloud upload or grant another user access.
3. On C, independently download the complete checkpoint and open the same task
    workspace. Select **Open checkpoint**, review its task, commit, and quoted context,
    then **Keep offline copy** to retain readable history even without B or enrollment.
4. To continue, prepare an independent clean code checkout at the exact checkpoint
    commit. Select it and choose **Create semantic fork**. C uses its own Copilot
    authentication and gets a new logical/native session with source/checkpoint lineage.
    Reviewed context is supplied only on the new session's first turn; tool approvals
    are never inherited. The source Host and active task route are not changed.

Checkpoints contain a bounded ordered event prefix, visible conversation context,
code commit/branch, provider capability marker, and SHA-256 digest. The limit is
16 MB per package and 60,000 context characters; dirty or mismatched code is rejected.
Credential-pattern scanning is defense in depth, not guaranteed secret removal.
The digest detects corruption, not the sharing source's authenticity. Trust and
review the source before importing; authorized downloaded copies cannot be recalled.

No native cross-machine Copilot fork is available. The package does not copy source
code, attachments, ignored/uncommitted files, dependencies, native runtime databases,
or hidden reasoning; required code and dependencies must be provisioned independently.
This is a semantic continuation, not a process snapshot or exact environment restore.

An unreachable B may still be executing. A fork never claims to stop or take over B.
There is no distributed lease/fencing authority, automatic ownership migration, or
Git/OneDrive locking protocol. Host and execution-directory locks coordinate only
cooperating Hosts within one profile; external CLI writers must remain idle.

Hosts are detached processes, not installed OS services. Desktop closure does not
stop them, but reboot does; restart is explicit. After a crash, verify that the old
process has exited before manually removing its reported stale lock. Missing native
history with accepted work is an error, never a silent replacement. The SDK does not
persist unused empty sessions, so those alone can be recreated under their reserved
native ID when the Host journal proves no command was accepted.

## Window zoom

Use **Ctrl+=** or **Ctrl+Shift+=** (Ctrl++) to zoom in, **Ctrl+-** to zoom out,
and **Ctrl+0** to return to 100%. The numeric keypad's plus, minus, and zero also
work. On macOS, use Command instead of Ctrl. The shortcuts work while a composer
or an in-app dialog has focus; ordinary plus/minus input and IME composition are
not intercepted.

The desktop uses Electron's native page zoom for the entire workbench, including
Explorer, Chat, text, icons, and controls, rather than changing just a font size.
Each press changes one level; the scale is `1.2 ** level`, with level 0 at 100%
and limits of -8 and 8. This follows the inspected
[VS Code window actions](https://github.com/microsoft/vscode/blob/645f29cc3176500b4b5762ba887cf2a7f0ffdf2c/src/vs/workbench/electron-browser/actions/windowActions.ts)
and [native zoom implementation](https://github.com/microsoft/vscode/blob/645f29cc3176500b4b5762ba887cf2a7f0ffdf2c/src/vs/platform/window/electron-browser/window.ts).
Task Continuum additionally accepts the main keyboard's Ctrl/Command+0 for reset.

Zoom is saved in the local desktop profile's `window-zoom.json` and restored on
reload or restart. It does not change the zoom or settings of a remote VS Code
Agent, and it does not overwrite preferred panel widths. Zooming into the compact
layout keeps the currently focused Explorer or Chat panel available. Browser-only
preview continues to use the browser's own zoom controls. No companion update is
needed; reopen the updated desktop to load its native shortcut handler.

## Resize panels

Drag the divider on the Explorer's right edge or Chat's left edge to adjust its
width. The divider highlights on hover or keyboard focus. Double-click it to
restore that panel's default width, or press Escape during a drag to cancel it.

Widths are saved in the local desktop profile across restarts and workspace
switches. Hiding a panel retains its size. Explorer stays at least 220 pixels wide,
Chat at least 310, and the central task area keeps at least 400. Smaller windows
temporarily fit the panels without overwriting their preferred sizes; at 1000
pixels or less, the existing compact single-panel layout takes over without dividers.
**Preferences > Reset panel layout** restores both widths while retaining the theme.
The same sizing applies to local, shared, and original VS Code chat panels.

## Keyboard

| Shortcut | Action |
| --- | --- |
| Ctrl/Command+P | Quick-open a task. |
| Ctrl/Command+B | Toggle the task sidebar. |
| Ctrl/Command+Alt+B | Toggle chat. |
| Ctrl/Command+= or Ctrl/Command+Shift+= | Zoom in the entire desktop window. |
| Ctrl/Command+- | Zoom out the entire desktop window. |
| Ctrl/Command+0 | Reset window zoom to 100%. |
| Left/Right on a tab | Switch open tasks or document views. |
| Up/Down in the task tree | Move focus between visible tasks. |
| Left/Right in the task tree | Collapse/expand a branch or move to its parent/first child. |
| Home/End in the task tree | Focus the first/last visible task. |
| Enter/Space in the task tree | Open the focused task. |
| Left/Right on a panel divider | Move the divider 10 pixels, or 50 with Shift. |
| Home/End on a panel divider | Set the controlled panel to its minimum/maximum available width. |
| Enter on a panel divider | Restore the controlled panel's default width. |
| Enter in chat | Send a message (except during IME composition). |
| Shift+Enter in chat | Insert a new line. |
| Escape | Cancel an active panel resize, close a dialog, or leave a compact panel. |

## Source boundaries

| Area | Responsibility |
| --- | --- |
| [src/main/index.ts](src/main/index.ts) | Desktop lifecycle, IPC sender validation, and local asset serving. |
| [src/main/security.ts](src/main/security.ts) | Frozen renderer security settings, CSP, resource and origin checks. |
| [src/preload/index.ts](src/preload/index.ts) | Window controls and allowlisted, typed local-session calls/events. |
| [src/main/copilotBridge.ts](src/main/copilotBridge.ts) | Trusted IPC registration and native folder-selection boundaries. |
| [src/main/copilotService.ts](src/main/copilotService.ts) | Official runtime, native sessions, streaming, cancellation, and permissions. |
| [src/main/vscodeSessions.ts](src/main/vscodeSessions.ts) | Bounded read-only discovery and reconstruction of VS Code transcripts. |
| [src/main/vscodeChatBridge.ts](src/main/vscodeChatBridge.ts) | Trusted original-history read/watch/open/send IPC. |
| [src/main/vscodeChatClient.ts](src/main/vscodeChatClient.ts) | Private companion discovery, authenticated identity checks, and exact-session open requests. |
| [src/main/vscodeChatExtension.ts](src/main/vscodeChatExtension.ts) | Explicit VS Code bridge lifecycle, version/trust checks, and original-chat opening. |
| [src/main/vscodeChatCompanion.ts](src/main/vscodeChatCompanion.ts) | Loopback authentication and existing-workspace/session restrictions. |
| [src/main/vscodeChatDelivery.ts](src/main/vscodeChatDelivery.ts) | Durable attributed submissions, retry deduplication, and native request reconciliation. |
| [src/main/vscodeChatDispatch.ts](src/main/vscodeChatDispatch.ts) | Confirmed exact-session delivery, original Agent checks, temporary template lock, and bounded acknowledgment. |
| [src/main/localSessionHost.ts](src/main/localSessionHost.ts) | Reviewed import snapshots and persistent history handoff. |
| [src/main/workspaceReader.ts](src/main/workspaceReader.ts) | Bounded, read-only AgentDesk task/document loading. |
| [src/main/workspaceStore.ts](src/main/workspaceStore.ts) | Current/recent workspace persistence and failure-safe switching. |
| [src/main/workspaceBridge.ts](src/main/workspaceBridge.ts) | Trusted native folder selection and ID-only recent-workspace access. |
| [src/main/repositorySessionLinks.ts](src/main/repositorySessionLinks.ts) | Strict relationship document, atomic writes, revision checks, and writer lock. |
| [src/main/shared/daemon.ts](src/main/shared/daemon.ts) | Independent Host process, native SDK owner, local locks, enrollment, and checkpoint freeze. |
| [src/main/shared/host.ts](src/main/shared/host.ts) | Authenticated command queue, ordered durable events, and one-time shared decisions. |
| [src/main/shared/client.ts](src/main/shared/client.ts) | SSH/loopback connection, contiguous replay, persistent cache, and offline state. |
| [src/main/shared/manager.ts](src/main/shared/manager.ts) | Private enrollments, Host lifecycle, repository routes, checkpoint copies, and forks. |
| [src/main/shared/checkpoint.ts](src/main/shared/checkpoint.ts) | Bounded checkpoint validation, digest, clean code reference, and semantic context. |
| [src/main/sharedBridge.ts](src/main/sharedBridge.ts) | Trusted shared-session IPC and native invitation/export review dialogs. |
| [src/shared/sharedSessions.ts](src/shared/sharedSessions.ts) | Logical sessions, execution/participant identities, events, and typed desktop contract. |
| [src/shared/sessionBindings.ts](src/shared/sessionBindings.ts) | Portable task/session relationship format and mutation contracts. |
| [src/shared/workspace.ts](src/shared/workspace.ts) | Typed workspace snapshots and restricted preload contract. |
| [src/shared/sessions.ts](src/shared/sessions.ts) | Structured-clone-safe session, event, and preload contracts. |
| [src/shared/chat.ts](src/shared/chat.ts) | UI/session adapter contract: task snapshot, history, cancellation, typed stream events. |
| [src/renderer/App.tsx](src/renderer/App.tsx) | Workbench composition, navigation, dialogs, and shortcuts. |
| [src/renderer/chat/useTaskChats.ts](src/renderer/chat/useTaskChats.ts) | Per-task draft/message state and request cancellation. |
| [src/renderer/chat/useSessionLinks.ts](src/renderer/chat/useSessionLinks.ts) | Repository-authoritative bindings, explicit legacy migration, and conflict recovery. |
| [src/renderer/components/SharedSessionPanel.tsx](src/renderer/components/SharedSessionPanel.tsx) | Shared conversation, participant controls, offline state, and reviewed continuation. |
| [src/renderer/components/VSCodeChatPanel.tsx](src/renderer/components/VSCodeChatPanel.tsx) | Original-session composer, attributed history, delivery state, and refresh/open/detach controls. |
| [src/renderer/chat/demoAdapter.ts](src/renderer/chat/demoAdapter.ts) | Deterministic, network-free demo responses, not an LLM. |
| [src/renderer/chat/copilotAdapter.ts](src/renderer/chat/copilotAdapter.ts) | Request-scoped desktop event streams; never a silent demo fallback. |
| [src/renderer/data/tasks.ts](src/renderer/data/tasks.ts) | Sample data, not a read of the planning workspace. |
| [e2e/desktop.spec.ts](e2e/desktop.spec.ts) | Production Electron smoke and isolation checks. |
| [e2e/copilot.spec.ts](e2e/copilot.spec.ts) | Read-only imports, restricted IPC, narrow layouts, and opt-in real Copilot continuity. |
| [e2e/workspace.spec.ts](e2e/workspace.spec.ts) | Real folder selection, recent-workspace switching, source preservation, and restart recovery. |
| [e2e/shared.spec.ts](e2e/shared.spec.ts) | Shared desktop, cache/checkpoints, independent Host lifecycle, and opt-in real semantic fork. |
| [e2e/vscode-bridge.spec.ts](e2e/vscode-bridge.spec.ts) | Isolated real VS Code original-ID opening without sending or forking. |

The renderer has no Node types or Node integration. Test code has a separate mixed
Node/DOM type environment. Production serves allowlisted assets under a custom
local protocol, blocks network requests with CSP, denies popup/navigation and
permission requests, and never exposes generic IPC, filesystem, or shell APIs.
Development permits only the additional script/connection behavior required by Vite.

## Data and boundaries

Native sessions persist in the SDK's local Copilot home, normally `~/.copilot`.
Reviewed text snapshots are saved atomically in the desktop profile's
`copilot-imports.json`. Real task/session links live in the task repository's
`.taskcontinuum/session-bindings.json`. Renderer storage retains display preferences,
demo bindings, and any legacy links awaiting explicit migration. Real tasks are
read from disk on open or refresh; task fixtures, demo edits/messages, and drafts
remain ephemeral. Detaching removes only the link; it does not delete native history.

Selecting a session that is already responding returns to its current task without
resuming or interrupting it. Responses have a ten-minute inactivity timeout, not
a total-duration limit: assistant/tool progress refreshes the timer, and pending
permission or user-input requests pause it. Those decisions retain their separate
five-minute deadline; unanswered requests are never approved automatically.

The local-only runtime uses SDK-owned stdio with no additional listening port.
Each shared Host separately owns an SDK stdio runtime and a bearer-authenticated
loopback HTTP/SSE endpoint, exposed remotely only through an SSH tunnel. Permissions
require an authorized participant's decision; they are not automatically approved.
Existing owner-machine authentication is reused; credentials and the SDK stay outside
the renderer. External CLI writers must be idle before resume. Distributed ownership
leases, managed OneDrive integration, and GitHub EMU synchronization remain deferred.

Shared private data resides under the desktop profile: `shared-identity.json`,
`shared-enrollments.json`, `shared-hosts/`, `shared-cache/`, and `shared-checkpoints/`.
Host configuration includes execution paths; grants and enrollments contain access
credentials. Journals/caches contain conversation and tool-decision data. Do not put
these files or native Copilot storage in Git or a synchronized live database folder.

Optional launch environment variables:

| Variable | Purpose |
|---|---|
| `TASKCONTINUUM_DATA_DIR` | Override the desktop profile, including reviewed imports, preferences, and demo/legacy bindings. |
| `TASKCONTINUUM_WORKSPACE` | Open an AgentDesk root at launch and remember it for subsequent restarts. |
| `TASKCONTINUUM_VSCODE_USER_DATA_DIR` | Override the VS Code data root, such as the directory containing `User/workspaceStorage`. |
| `COPILOT_CLI_PATH` | Use an explicit compatible runtime executable instead of the SDK-bundled runtime. |
| `COPILOT_HOME` | Select a different local Copilot data home, as supported by the runtime. |

Protect the local profile and Copilot home as conversation data. The application
does not read VS Code credential databases, rewrite VS Code logs, or send sample
task metadata as if it were a real task workspace.

The planning workspace is a separate sibling repository. Its original Vite
prototype remains unchanged; this repository is the implementation source of truth.
The local Git branch is `main`; this setup does not create a GitHub remote or publish code.

## Verification baseline

On Windows, 2026-09-06: 75 unit/component/security tests and all 10 Electron tests
passed with the live opt-in enabled, with clean lint, strict types, and production
builds. Three real replies verified native creation, same-ID continuation after
restart, and imported context. Source preservation was checked byte-for-byte.
Desktop and 420px narrow screenshots were visually reviewed. Other operating
systems, installers, signing, auto-updates, and remote service integration are not
yet validated. This is a runnable desktop development build, not an installer.

The later 2026-09-06 regression fix passed 82 unit/component/security tests, lint,
strict types, and production build. All nine offline Electron scenarios passed;
the opt-in live scenario was not rerun. Added cases cover reopening a streaming
session, progress-aware timeouts, permission/question waits, and silent requests.

The workspace-switching update passed 102 unit/component/security tests, lint,
strict types, and production build. All 13 non-model Electron scenarios passed
with `TASKCONTINUUM_VERIFY_WORKSPACE=Q:\src\Projects\TaskContinuum-ad`, including
a read-only comparison of actual task IDs/titles/statuses and byte-for-byte checks
of source documents. Without that variable, the local-repository check is skipped;
the authenticated model scenario remains a separate opt-in. Desktop and 420px
workspace-picker screenshots were reviewed, including button viewport bounds.

The multilevel-tree update passed 111 unit/component/security tests and all 14
non-model Electron scenarios, including parent/child ordering, independent folding,
filtered ancestor paths, keyboard navigation, and three-level indentation in desktop
and 420px windows. Task relationships remain read-only; the model scenario was not rerun.

The repository-session-link update passed 129 unit/component/security tests, lint,
strict types, and production build. All 15 non-model Electron scenarios passed,
including explicit legacy migration, Git-visible metadata and ignored temporary
files, recovery in a fresh desktop profile, external-edit conflicts, and unlinking
without changing task documents. The authenticated model scenario was not rerun.

The 2026-09-07 shared-session update passed 152 tests, lint, strict types, and the
production build. All 18 non-model Electron scenarios passed with the real planning
workspace check and `TASKCONTINUUM_HOST_LIFECYCLE=1`; two live-model scenarios were
skipped in that full run. Lifecycle coverage uses the actual SDK without sending a
model request and verifies desktop exit, retained Host connectivity, and owner restart.

An additional `TASKCONTINUUM_LIVE_SHARED=1` run passed with two synthetic model
requests: a source reply and a genuine new completed reply after a reviewed semantic
fork in another profile/checkout. It checked distinct logical/native/owner identities
and exact new command events, not text found in imported history. Desktop and 420px
shared-panel screenshots were reviewed. These opt-ins require local authentication;
live prompts consume Copilot usage. Scope them with `npm run test:e2e -- e2e/shared.spec.ts`.

The SSH test uses the actual system OpenSSH client, public-key authentication,
strict pinned host-key checking, forwarding, and replay against an isolated temporary
SSH server on loopback. It does not change system services or user SSH configuration.
All machine identities in this verification are separate profiles on one Windows host.
Physical A/B/C networking and approved OneDrive cross-machine synchronization have
not been tested. No installer, managed service, automatic failover, or native fork is claimed.

The original VS Code link/open increment passed 162 tests, lint, strict types, and
production build. The desktop scenario verifies repository-backed original identity,
source updates, restart, detach, and 420px layout without starting the CLI. The real
VS Code 1.136.1 scenario opens a synthetic original conversation and checks its bound
resource, original question/answer, unchanged source bytes, and no additional saved
session. It makes no model request and uses an isolated profile. Screenshots were
reviewed. This is evidence for linking/opening, not desktop-side message execution.

The later sending increment adds a real-VS-Code targeted-delivery test with two
existing sessions and an explicitly named deterministic test participant. It verifies
that only the intended original receives a new request and reply, the native ID is
retained, authors and execution machines match, and retrying the same command does
not duplicate it. Separate Electron coverage exercises the desktop composer,
attribution, restart, offline history, and 420px layout. This verifies the transport
and session lifecycle, not an authenticated hosted Copilot response; that latter
check remains dependent on a signed-in VS Code environment. No credentials were
copied and no user conversation was used as a fixture.

To run the real companion check after building its VSIX:

```powershell
$env:TASKCONTINUUM_VERIFY_VSCODE = 'C:\Program Files\Microsoft VS Code\Code.exe'
$env:TASKCONTINUUM_VERIFY_VSCODE_SEND = '1'
npm run test:e2e -- e2e/vscode-bridge.spec.ts
Remove-Item Env:TASKCONTINUUM_VERIFY_VSCODE_SEND
Remove-Item Env:TASKCONTINUUM_VERIFY_VSCODE
```

The desktop connection repair passed 181 tests, lint, strict types, and production
build. Two focused Electron scenarios cover the Connect button through IPC, rejection
of invalid identities, unchanged drafts, automatic send readiness, original opening,
and 420px controls. Real VS Code 1.136.1 tests enter through the connection URI,
confirm the bridge, and verify original-session opening and deterministic participant
delivery. The complete hosted Copilot check remains separate. Desktop and narrow
connection screenshots were reviewed; no user messages were sent for verification.

The 0.2.2 layout repair passed 183 tests, lint, strict types, and production build.
A real, normally installed VS Code 1.136.1 test keeps the original in the sidebar
and a different conversation in the editor. A confirmed deterministic reply and
same-command retry preserve the original IDs, other conversation, editor tabs,
group count, and panel bounds. Before/after screenshots were reviewed. Missing-widget
and template-load failures also leave the source unchanged without an open fallback.
This verifies the reported layout regression, not an authenticated hosted Copilot
response or a separately established native-crash cause. VS Code tests now keep
their isolated installed extensions/profiles under the OS temporary directory and
clean them after closing, rather than adding those directories to the workspace.

The 0.2.3 template repair passed 189 tests across 34 files, lint, strict types, and
production build. The installed-VS-Code regression preloads the mode cache and
verifies two consecutive distinct submissions, both persisted replies, exact new
request IDs and text, retry deduplication, template restoration, and unchanged
sidebar/editor layout. The test uses an isolated deterministic participant with no
hosted model or user messages. A document-edit experiment was not retained; template
updates do not use `WorkspaceEdit`, show an editor, or change the user's settings.

The 0.2.4 readiness update passed 191 tests, lint, strict types, and production build.
Installed VS Code 1.136.1 verified non-sending startup and consecutive distinct
deliveries with file watching excluded; another no-model run verified connection/open
compatibility. The readiness tests reject stale state and release the private lock.
An attempted negative control did not isolate incidental refreshes and was removed;
it is not evidence that the user's exact environment has been reproduced or repaired.

The 0.2.6 long-history regression passed 195 tests, lint, strict types, and production
build. Two focused Electron scenarios include a JSONL conversation above 32 MiB:
discovery, preview/link, source updates, restart, detach, and source preservation.
Unit checks cover split UTF-8, incomplete final records, invalid complete records,
cache invalidation/isolation, and each size limit. A read-only check of the actual
32.78 MiB original session verified that it is readable and listed again, without
messages or credentials in diagnostic output. No user message or binding was changed.

Third-party attribution is recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
The application does not claim VS Code or GitHub Copilot affiliation.