# Task Continuum

A focused Electron workbench for tasks and the conversations that move them forward.
Familiar VS Code-style navigation, without an editor, extension host, terminal, or debugger.

**Native Agent Host workbench.** Task Continuum uses the official Agent Host
protocol (AHP) 0.9.0 for session discovery, selection, explicit creation, binding,
reopening, sending, live streaming, cancellation and model options. Local and
remote access retain the original Host, session, chat and owner identities.
AgentDesk workspace folders provide canonical task files, quick UI creation and
an agent/CLI creation path. Existing task views remain read-only. New profiles start with
no workspace, no tasks, and no open task tabs; there is no built-in demo.

Local Copilot SDK execution, CLI resume/import, VS Code journal/Companion sessions,
shared SDK Hosts, checkpoint continuation and their legacy session IPC are retired.
No Companion extension is required or packaged. Existing sessions, profiles and
key files are not deleted or imported into the new runtime.

## What works

- Activity bar, task explorer, open-task tabs, task viewer, chat, and status bar.
- Quick task creation from the Explorer or empty state, plus direct local Agent
  Host conversations, JSON draft review and the shared task-creation CLI.
- Search by task ID, title, or owner; filter by status; navigate a multilevel task tree.
- Parent-first task ordering, hierarchy guides, independent branch folding, and
    ancestor paths retained for filtered matches.
- Overview, requirements, plan, and acceptance checklist views.
- First-run guidance to create an empty task/config Git repository and explicitly
  publish it to GitHub, private by default.
- Per-task native conversations and drafts, streamed responses, cancellation and
  explicit failure states, without automatic message replay.
- Markdown assistant replies with GFM tables/task lists, readable code blocks and
  explicit code-text copying.
- Clipboard screenshots and image files with previews, removal, image-only
  messages and authenticated native local/remote delivery.
- Independent desktop sidebar/chat toggles, compact single-pane navigation,
  keyboard quick-open, and dark/light appearance.
- Sandboxed Electron renderer with a minimal typed preload bridge.
- Native Host discovery, exact task/session binding and reopening, explicit native
  creation, model/configuration selection, reasoning/tool status and terminal output.
- Remote devices over managed Dev Tunnel + restricted SSH, with browser sign-in,
  protected device keys, scoped pairing, revocation and private offline caches.
- Native provider sign-in, tool approvals and agent questions remain on the owner.
- Immutable signed workspace records for public device identities, invitations,
  bindings and typed settings; session history and private credentials stay off Git.
- Native workspace folder selection, recent-workspace switching, and restart recovery.
- Real task metadata, statuses, requirements, plans, and acceptance criteria read from
    the selected AgentDesk folder; manual refresh picks up external file changes.

## Requirements

- Node.js 24 LTS and npm. Verified with Node 24.14.1 and npm 11.11.0 on Windows.
- Internet access for the initial dependency and Electron runtime download.
- A graphical desktop for Electron smoke tests. Offline tests need no model account.
- Real chat requires a running VS Code 1.137 Agent Host supporting AHP 0.9.0,
    an authorized Copilot provider account on the execution machine and network
    access to its service. Task Continuum does not start a replacement Host or
    manage provider authentication. Never put tokens in the UI.
- Managed remote Agent Host access requires the official Microsoft Dev Tunnel CLI,
    the same Microsoft work-account owner signed in on both machines, approved
    outbound connectivity, and OS secure storage. The app manages its own restricted
    SSH endpoint; no OS SSH server, port 22 mapping, account, or SSH alias is required.
    Dev Tunnels is a preview development/testing service without a production SLA.
- Both Task Continuum desktops need compatible AHP/device builds. The connecting
    desktop needs no separate Copilot CLI runtime or sign-in.

## Run and verify

Run commands from this repository's root. Dependencies are pinned in
[package.json](package.json) and [package-lock.json](package-lock.json).

| Command | Purpose |
| --- | --- |
| `npm ci` | Install locked dependencies and the Electron runtime. |
| `npm run dev` | Start the Electron application with renderer hot reload. |
| `npm run dev:web` | Preview the empty browser workbench at http://127.0.0.1:5178; local repository and native session operations require Electron. |
| `npm run typecheck` | Check main/preload, browser, and test environments separately. |
| `npm run lint` | Run ESLint with no warnings permitted. |
| `npm test` | Run unit and React component tests. |
| `npm run build` | Type-check and build production main/preload/renderer output. |
| `npm start` | Open the already-built Electron application. |
| `npm run check` | Run lint, unit tests, and production build. |
| `npm run test:e2e` | Build and run real Electron tests; native AHP opt-ins are described below. |

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

Enable [Automatic workspace links](#automatic-workspace-links) for the selected
task workspace before reading or writing bindings. Open **Agent Host sessions**
in the activity bar, allow local Host access once, and select the existing chat.
Detach a different task binding explicitly before replacing it; detaching never
deletes native history. The Host and its signed-in provider must already be running.
Selecting a task or reopening its chat never creates or resumes a CLI session.

For another desktop, use **Remote devices** and its private Dev Tunnel +
restricted SSH pairing. B confirms the exact native binding; A selects the task
after receiving the authorized link. No new tunnel port, per-session invitation
or Host-wide credential is required. Workspace read/send policy and B's private
local confirmation receipt remain mandatory; Git metadata alone is not authority.

Creation is a separate explicit native action, never a fallback for an unavailable
session. **Create on remote worker** uses the selected paired worker's shared task
workspace and existing send permission. It uses native Folder isolation, sends no
initial or warm-up prompt, and retains a durable operation for binding-only recovery.
See [remote creation and recovery](docs/remote-vscode.md#create-on-a-remote-worker).

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

Each binding requires `provider: "agent-host"`, `hostId`, `sessionId`, `chatId`
and a stable owner (`clientId`, `machineName`). Native Copilot sessions use
`copilotcli:/...` and `ahp-chat://default/...`; the prototype's `ahp-session:/...`
form is also accepted.
Only the verified `copilotcli` provider is currently listed; this native URI is
not a CLI resume/import route. The binding contains no endpoint token, route or
history. Host instance identity is pinned: replacing/restarting that Host does
not silently select a different process; explicitly verify and relink its existing
session if needed. AHP cannot subscribe to extension-host Local conversations or
preserve their runtime by starting a new Host. See
[the remote runbook](docs/remote-vscode.md#agent-host-ahp).

### Isolated AHP proof of concept

The opt-in [AHP test](e2e/ahp.spec.ts) uses the official
`@microsoft/agent-host-protocol` runtime client and an actual standalone VS Code
Agent Host. On Windows with VS Code 1.137 installed, run:

```powershell
$env:TASKCONTINUUM_VERIFY_AHP_CLI = 'C:\Program Files\Microsoft VS Code\bin\code-tunnel.exe'
try { npx playwright test e2e\ahp.spec.ts }
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

On an already running VS Code 1.137 Editor Host, the following opt-in checks
read-only discovery, authenticated named-pipe/TCP handshake and ping:

```powershell
$env:TASKCONTINUUM_VERIFY_AHP_LOCAL = '1'
try { npm test -- test\agent-host.test.ts }
finally { Remove-Item Env:TASKCONTINUUM_VERIFY_AHP_LOCAL -ErrorAction SilentlyContinue }
```

It sends no model prompt and reads no conversation content. The actual runtime
exposes `agenthost-terminal:` resources as well as the documented `ahp-terminal:`
scheme; both remain restricted to terminal references owned by the linked chat.

## Chat Markdown

Assistant replies use the existing `react-markdown` and `remark-gfm` stack instead
of displaying Markdown source as plain text. Headings, emphasis, inline code,
lists, disabled task checkboxes, quotes, strikethrough, and tables are rendered.
Single line breaks remain visible. Code blocks show their language and a **Copy
code** action; long code and tables scroll within the message, including narrow
Chat panels. User messages and delivery receipts retain their original literal text.

The same renderer handles live Agent Host replies, native snapshots and private
cached replies. Updated text is rendered again, including an
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
the display is implemented in Task Continuum's desktop and preload.

## Image Attachments

Paste a screenshot with Ctrl+V (Cmd+V on macOS), or choose **Attach images** in
the composer. Preview or remove thumbnails before sending. Text is optional.
PNG, JPEG, GIF and WebP are accepted: up to four images, 5 MiB each and 10 MiB
per message. Invalid or oversized images leave the existing draft unchanged.
Reading finishes before Send becomes available; failed submissions retain the draft.
Ordinary text paste is unchanged. No background clipboard access is requested.

Agent Host attachments use the authenticated native local or paired-device route,
not a client filesystem path or a history import. Image handling still depends on
the native model and tools; attaching an image does not bypass owner-side approvals
or replace the original Host, session or chat.

Full-size previews use images retained in the current desktop view. Image bytes
and session history are not published in Git records. Drafts remain in memory and
follow the existing composer lifetime; restarting the desktop discards unsent drafts.

## Create a task repository

1. On first launch, choose **Create task repository**. The Explorer starts empty;
   existing profiles still reopen their last selected workspace.
2. Enter an existing absolute **Parent directory** (or use **Browse**) and a
   **Repository name**, for example `C:\Tasks` and `my-tasks`. Choose **Create
   repository** to create `C:\Tasks\my-tasks`, initialize Git on `main`, and commit
   the initial configuration and empty task folder. Existing folders are never
   overwritten, and no sample tasks, chats, or device enrollment are created.
3. The guide advances to **GitHub website**. Choose **Create on GitHub** to open
   `https://github.com/new` with the repository name prefilled. Sign in with your
   Enterprise Managed User (EMU) account, select an owner allowed by your
   enterprise, and confirm the name and visibility on GitHub. EMU personal
   repositories must be **Private**; enterprise organizations may allow
   **Private** or **Internal**, subject to policy. Create an **empty** repository:
   do not initialize a README, `.gitignore`, or license.
4. Paste its HTTPS or SSH repository URL into the guide and choose **Get push
   commands**. EMU owner names such as `yourname_enterprise` are supported, and the
   GitHub repository name can differ from the local folder. Review and copy the
   commands, then run them in your terminal (PowerShell on Windows). They select
   the exact local repository, add `origin` only if absent, and push the current
   branch. Existing remote destinations are never silently replaced.
5. Choose **I've pushed - Check** to verify the remote branch against the current
   local commit. This explicit check is read-only; opening the guide or preparing
   commands does not contact GitHub, create a remote, or push anything.
6. Alternatively, choose **Keep local for now**. The repository is already usable
   and restored after restart. Use the Explorer's **Publish workspace to GitHub**
   icon to return to the publishing guide, or its **New task repository** icon
   to create another repository.

Local creation needs Git and a configured Git author name/email; it does not need
GitHub or a network connection. **GitHub CLI (`gh`) is not required.** If your
terminal can already push to GitHub, reuse that setup. HTTPS Git can use your
existing Git Credential Manager (GCM) credentials; if it prompts, finish the
browser/enterprise SSO sign-in using the intended EMU account. A GitHub website
login is not by itself a terminal Git login. Existing SSH authentication is also
supported. The guide detects configured helpers without reading credentials,
does not replace them, and never asks you to paste a token.

Verification uses the configured Git credentials noninteractively. If credentials
are missing or expired, finish `git push` in the terminal and retry the check.
It cannot infer your EMU identity or repository visibility from a URL, so confirm
both on GitHub. Enterprise policy remains authoritative; see
[managed-user repository restrictions](https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/understanding-iam-for-enterprises/abilities-and-restrictions-of-managed-user-accounts#repository-management).

The repository holds `.agentdesk/config.json` and `tasks/`; the empty task folder
is retained in Git. Create tasks from the Explorer, or use a compatible agent/CLI
and refresh to read them. Existing task views remain read-only. This guide does
not automatically enroll remote devices, enable automatic workspace links, or
upload later edits. Review committed files before publishing; credentials and
private session history must never be committed. A publication failure is shown
explicitly and leaves the local repository available for retry.

The guide can also prepare commands and verify an existing GitHub remote without
claiming ownership of it. Reopening the guide shows local Git configuration, not
an assumed successful publication; choose the explicit check to confirm the
remote commit. Browser creation and terminal push failures never cause automatic
recreation, retries that write remote state, or force pushes. Existing local
onboarding records remain local to `.git` and are not uploaded.

## Create tasks quickly

Open a real task workspace, then use either entry:

1. **UI:** select **New task** (`+`, or Ctrl/Cmd+N) in the Explorer, or **Create
   first task** in an empty task list. Only a title is required. Add a description
   or parent, and optionally choose owner, priority, type, hierarchy level, folder
   slug and acceptance criteria. Workspace defaults are used otherwise.
   **Create task** allocates a unique `T-XXXX`, writes the canonical task folder
   and lifecycle documents, refreshes the tree and selects the new task.
2. **Agent:** select **Create task with agent** to open the right-hand chat panel
   with a local native Agent Host session in the selected repository, including
   an empty workspace. A single
   available Host is selected automatically; with multiple Hosts, choose one
   explicitly. Select a model, describe the goal, and chat directly in the app.
   The first message includes task-creation guidance and the source CLI location
   when available. After the agent creates files, **Refresh created tasks** loads
   them without closing the conversation. Alternatively, choose **Review agent
   draft** in the chat panel to open the JSON review form and confirm creation.

The local Host and signed-in Copilot provider must already be running. Entering
agent mode creates a session, but does not send a prompt until you submit one.
Reopening the chat panel resumes the same workspace conversation. Task creation
chat stays alongside the task tree and viewer; only quick creation and JSON draft
review use dialogs. **Show task conversation** returns to the selected task's chat.
Creation identity and access are recorded privately on this device, not in Git or task bindings;
this does not grant remote devices access or require Automatic workspace links.
An uncertain creation is inspected rather than replayed. Native approvals remain
on the local Host. The draft-review path also works when no Host is available or
the installed application does not include the source CLI.

UI and CLI creation share the same writer. IDs include existing and archived
tasks, configured members/hierarchy are checked, and a complete new directory is
published without overwriting another task. Existing parent files, statuses,
session links and Git state are not changed. No commit or push occurs.
See [task creation CLI](docs/task-documents.md#task-creation) for agent automation.

## Open a task workspace

1. In the desktop explorer, choose the folder icon labeled **Open workspace folder**.
    The title-bar folder icon is also available when the sidebar is hidden.
2. Select the workspace root, for example `Q:\src\Projects\TaskContinuum-ad`,
    not its `tasks` subdirectory. The root must contain `.agentdesk/config.json`.
3. Use the **Workspace** dropdown to switch between recent folders or return to
    **No workspace**. Closing a workspace clears its task views but retains recent
    folders. The selected folder is restored after restart.
4. Use **Refresh workspace** after editing task files in VS Code or another tool.

New tasks can be created through the UI or agent/CLI entry above. Existing-task
status changes and checklist toggles still require an external editor or compatible
automation; their viewers remain read-only. Opening a
workspace does not change any planning files or execute instructions found in them.
Explicit session link and unlink actions write only the relationship metadata
described below; they do not change task JSON, status, or acceptance documents.
Markdown is rendered without active links, external images, or HTML execution.
Invalid tasks and unavailable documents are reported in the explorer's warnings.

Workspace switches reset task tabs and unsent drafts. Each workspace owns its
immutable record namespace, so identical task IDs in unrelated folders do not
share links.
Cloning a workspace carries its checked-in links without carrying a machine path.
Cloned metadata does not grant local trust or authorize a session by itself.
Stop active responses before switching. Native creation uses the explicitly
selected workspace; selecting an unbound task never starts an Agent automatically.

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

## Automatic workspace links

Open **Remote devices > Automatic workspace links** and enable the immutable
backend with native consent. The workspace must have an existing tracked Git
upstream; no branch or remote is guessed. An unconfigured workspace reads task
documents only. Binding reads and writes require this backend to be enabled,
including when devices were paired explicitly. Pause does not enable a fallback.

Each synchronization cycle follows the current branch's configured upstream;
there is no permanent branch binding or implicit main/master target. Switching
branches keeps cached configuration, pending edits and device trust. A missing
upstream pauses Git sync with a visible error, not workspace opening or local
configuration editing. Repository URL changes still require trust review.

The workspace descriptor is `.taskcontinuum/workspace.json`. The only public
record types are **device**, **invitation**, **binding** and **setting**:

```text
.taskcontinuum/records/v1/devices/<deviceId>/<operationId>.json
.taskcontinuum/records/v1/invitations/<issuerId>/<recipientId>/<operationId>.json
.taskcontinuum/records/v1/bindings/<taskId>/<operationId>.json
.taskcontinuum/records/v1/settings/<scope>/<key>/<operationId>.json
```

Operations are signed, hash-addressed and immutable. Git merges add records,
not edits to a shared registry. Typed settings describe device/workspace
configuration, not session model options. History, requested model/configuration,
image bytes, private invitations, private keys, endpoint tokens and authorization
receipts remain outside Git. Public metadata alone cannot grant session access.

Synchronization runs at a fixed **15-second** cadence. A local configuration edit
durably saves its operation and immediately schedules Git publication. Binding
edits also send the exact signed operation and bounded dependency closure to
affected SSH peers immediately, without waiting for Git.

A receiving peer validates that provisional binding and requests an immediate
pull. It reconciles only when the **exact operation** appears in validated
canonical Git data; an earlier successful pull is not confirmation. Concurrent
operations and descendants use the same resolver. Provisional values expire
after 60 seconds; expiry or restart leaves an explicit awaiting-sync marker and
disables the affected binding instead of restoring an older route.

Only complete `agent-host` bindings with the original `hostId`, `sessionId`,
`chatId` and owner are accepted, including through signed records and SSH notices.
Conflicting heads remain visible and ambiguous bindings are disabled. The same
canonical session cannot have two active task claims. Resolve known heads by
explicitly selecting the intended native session or detaching at the current
revision; never delete immutable history to clear a conflict.

The old `session-bindings.json` and workspace `localStorage` bindings are not
read, migrated or written. There is no migration button or legacy migration IPC.
Existing files remain untouched. Enable Automatic workspace links and explicitly
select the existing native Host sessions again. Unsupported local store metadata
or authorization receipts are reported, not reset or imported.

Local link receipts accept only the current Agent Host format. Old Local receipts
and mixed-format files are rejected, not ignored, migrated or automatically reset.
Fully quit the desktop before explicitly removing obsolete receipt entries;
preserve current receipts and never convert old identity fields into authorization.
If a previous link attempt saved a binding without a receipt, clean the file first,
then use **Review session link** to explicitly confirm the same native Host session.
Successful confirmation reconnects the chat without clearing its draft. See
[receipt recovery](docs/remote-vscode.md#local-link-receipt-recovery).

Automatic synchronization uses an app-owned Git replica and safe source refresh;
it does not stage unrelated task/code changes or rebase unpublished user commits.
See [workspace Git synchronization](docs/workspace-git-sync.md) for enrollment,
typed configuration editing, conflict resolution and revocation, and
[task-document validation](docs/task-documents.md) for the owned read-only checker.

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
preview continues to use the browser's own zoom controls.

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
The same sizing applies to Agent Host chat and the empty first-run workbench.

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
| [src/preload/index.ts](src/preload/index.ts) | Window controls and allowlisted, typed Agent Host, device and workspace calls/events. |
| [src/main/workspaceReader.ts](src/main/workspaceReader.ts) | Bounded, read-only AgentDesk task/document loading. |
| [src/main/workspaceStore.ts](src/main/workspaceStore.ts) | Current/recent workspace persistence and failure-safe switching. |
| [src/main/workspaceBridge.ts](src/main/workspaceBridge.ts) | Trusted native folder selection and ID-only recent-workspace access. |
| [src/shared/workspace.ts](src/shared/workspace.ts) | Typed workspace snapshots and restricted preload contract. |
| [src/shared/chat.ts](src/shared/chat.ts) | UI/session adapter contract: task snapshot, history, cancellation, typed stream events. |
| [src/renderer/App.tsx](src/renderer/App.tsx) | Workbench composition, navigation, dialogs, and shortcuts. |
| [src/renderer/chat/useTaskChats.ts](src/renderer/chat/useTaskChats.ts) | Per-task draft/message state and request cancellation. |
| [src/renderer/components/RepositorySetup.tsx](src/renderer/components/RepositorySetup.tsx) | Local repository creation and explicit GitHub publication guide. |
| [e2e/desktop.spec.ts](e2e/desktop.spec.ts) | Production Electron smoke and isolation checks. |
| [e2e/workspace.spec.ts](e2e/workspace.spec.ts) | Real folder selection, recent-workspace switching, source preservation, and restart recovery. |
| [e2e/agent-host-desktop.spec.ts](e2e/agent-host-desktop.spec.ts) | Native Host discovery/binding, live state, reconnect and desktop/compact layouts. |

The renderer has no Node types or Node integration. Test code has a separate mixed
Node/DOM type environment. Production serves allowlisted assets under a custom
local protocol, blocks network requests with CSP, denies popup/navigation and
permission requests, and never exposes generic IPC, filesystem, or shell APIs.
Development permits only the additional script/connection behavior required by Vite.

## Data and boundaries

Native sessions remain on their owning Agent Host. Public workspace metadata is
limited to the immutable records described above. The private desktop profile
holds device enrollment, protected keys, owner receipts, delivery recovery state,
configuration outboxes and bounded offline caches. A configuration outbox never
queues prompts. Session model options and history are not Git settings or records.

Real tasks are read from disk on open or refresh. Sample task data exists only in
test fixtures, not in the application bundle. Drafts remain ephemeral.
Detaching changes only the binding, not native history.
An unavailable owner is reported explicitly, without a substitute session, runtime
or fabricated reply. Native approvals stay on the owner; reconnecting recovers state,
never a queued send. Disconnecting a device or closing its desktop does not stop
the Agent Host, and revocation cannot undo already accepted work or downloaded data.

Generic SSH device pairing and Dev Tunnel transport remain supported. Historical
device filenames and provider labels retain the existing device identity and
protected keys, not retired session-specific IPC. Legacy session metadata and
cache files remain inert: they are not read into session configuration or used
for authorization, and no automatic migration or file cleanup occurs. Private
identities, tokens and history must not be placed in Git or synchronized as live
databases.

Optional launch environment variables:

| Variable | Purpose |
|---|---|
| `TASKCONTINUUM_DATA_DIR` | Override the private desktop profile for preferences, device enrollment, caches and recovery state. |
| `TASKCONTINUUM_WORKSPACE` | Open an AgentDesk root at launch and remember it for subsequent restarts. |

Protect the local profile and native owner storage as conversation data. The application
does not read VS Code credential databases, rewrite VS Code logs, or send sample
task metadata as if it were a real task workspace.

The planning workspace is a separate sibling repository. Its original Vite
prototype remains unchanged; this repository is the implementation source of truth.
The local Git branch is `main`; this setup does not create a GitHub remote or publish code.

Third-party attribution is recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
The application does not claim VS Code or GitHub Copilot affiliation.