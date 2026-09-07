# Task Continuum

A focused Electron workbench for tasks and the conversations that move them forward.
Familiar VS Code-style navigation, without an editor, extension host, terminal, or debugger.

**Local and shared-session MVP.** The desktop can connect to GitHub Copilot,
resume native CLI sessions, and continue reviewed VS Code text history in a new
Copilot session. It can also open real AgentDesk workspace folders as read-only
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
- Independent desktop sidebar/chat toggles, compact single-pane navigation,
  keyboard quick-open, and dark/light appearance.
- Sandboxed Electron renderer with a minimal typed preload bridge.
- Real local Copilot authentication, model selection, new sessions, same-ID resume,
    streamed responses, tool activity, and cancellation.
- Searchable CLI/VS Code session lists, read-only transcript previews, and explicit
    import confirmation before continuing a VS Code conversation.
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
- Remote live views require system OpenSSH on the participant and an independently
    configured SSH server on the owner. Public-key authentication, a trusted host key,
    and loopback TCP forwarding must already work. The app does not install SSH,
    edit your SSH configuration, accept passwords, or bypass host-key verification.

## Run and verify

Run commands from this repository's root. Dependencies are pinned in
[package.json](package.json) and [package-lock.json](package-lock.json).

| Command | Purpose |
| --- | --- |
| `npm ci` | Reproduce the locked dependency installation. |
| `npm run dev` | Start the Electron application with renderer hot reload. |
| `npm run dev:web` | Preview the demo browser UI at http://127.0.0.1:5178; native session operations require Electron. |
| `npm run typecheck` | Check main/preload, browser, and test environments separately. |
| `npm run lint` | Run ESLint with no warnings permitted. |
| `npm test` | Run unit and React component tests. |
| `npm run build` | Type-check and build production main/preload/renderer output. |
| `npm start` | Open the already-built Electron application. |
| `npm run check` | Run lint, unit tests, and production build. |
| `npm run test:e2e` | Build and run real Electron tests; live model calls are skipped unless explicitly enabled. |

The Electron development renderer uses port 5177; browser-only preview uses 5178.
Both bind to loopback and fail rather than silently changing ports. Stop an existing
preview if its port is already occupied.

Desktop tests use the installed Electron executable, not a downloaded Playwright
browser. Their isolated profiles, screenshots, and reports are ignored by Git.
Screenshots cover dark, light, contextual chat, and compact layouts.

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
    then choose **Continue in new session**. The first message carries the reviewed context.
5. Send a message. Review tool requests with **Deny** or **Allow once**, or use **Stop response**.

VS Code import is a text-history handoff, not control of an active VS Code Chat process.
It does not transfer attachments, tool results/state, pending edits, or hidden reasoning.
Import itself makes no model request and never changes the source file. Files above
32 MB are skipped; the most recent 60,000 text characters/500 messages are previewed,
with truncation and unreadable-source warnings shown explicitly.

To opt into three small authenticated model requests that verify creation, restart
continuity, and imported context:

```powershell
$env:TASKCONTINUUM_LIVE_COPILOT = '1'
npm run test:e2e
Remove-Item Env:TASKCONTINUUM_LIVE_COPILOT
```

The live test sends only synthetic prompts and a synthetic transcript, not your
existing conversations. Requests can consume Copilot usage. Normal tests remain offline.

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
        }
    }
}
```

The example ID is illustrative. Opening or creating a real conversation records
the native SDK session ID only after the repository write succeeds. Selecting a
task then resumes that ID; selecting an already-linked session returns to its task.
The current MVP permits one session per task and one task per session in a workspace.
Detach an existing link explicitly before moving the session to a different task.

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
corresponding native Copilot history or a separately published shared Host. Unavailable
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
`.taskcontinuum/session-bindings.json` remains local-only and is never promoted
silently. Git merge conflicts and competing active routes require manual resolution.

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

## Keyboard

| Shortcut | Action |
| --- | --- |
| Ctrl/Command+P | Quick-open a task. |
| Ctrl/Command+B | Toggle the task sidebar. |
| Ctrl/Command+Alt+B | Toggle chat. |
| Left/Right on a tab | Switch open tasks or document views. |
| Up/Down in the task tree | Move focus between visible tasks. |
| Left/Right in the task tree | Collapse/expand a branch or move to its parent/first child. |
| Home/End in the task tree | Focus the first/last visible task. |
| Enter/Space in the task tree | Open the focused task. |
| Enter in chat | Send a message (except during IME composition). |
| Shift+Enter in chat | Insert a new line. |
| Escape | Close a dialog or leave a compact panel. |

## Source boundaries

| Area | Responsibility |
| --- | --- |
| [src/main/index.ts](src/main/index.ts) | Desktop lifecycle, IPC sender validation, and local asset serving. |
| [src/main/security.ts](src/main/security.ts) | Frozen renderer security settings, CSP, resource and origin checks. |
| [src/preload/index.ts](src/preload/index.ts) | Window controls and allowlisted, typed local-session calls/events. |
| [src/main/copilotBridge.ts](src/main/copilotBridge.ts) | Trusted IPC registration and native folder-selection boundaries. |
| [src/main/copilotService.ts](src/main/copilotService.ts) | Official runtime, native sessions, streaming, cancellation, and permissions. |
| [src/main/vscodeSessions.ts](src/main/vscodeSessions.ts) | Bounded read-only discovery and reconstruction of VS Code transcripts. |
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
| [src/renderer/chat/demoAdapter.ts](src/renderer/chat/demoAdapter.ts) | Deterministic, network-free demo responses, not an LLM. |
| [src/renderer/chat/copilotAdapter.ts](src/renderer/chat/copilotAdapter.ts) | Request-scoped desktop event streams; never a silent demo fallback. |
| [src/renderer/data/tasks.ts](src/renderer/data/tasks.ts) | Sample data, not a read of the planning workspace. |
| [e2e/desktop.spec.ts](e2e/desktop.spec.ts) | Production Electron smoke and isolation checks. |
| [e2e/copilot.spec.ts](e2e/copilot.spec.ts) | Read-only imports, restricted IPC, narrow layouts, and opt-in real Copilot continuity. |
| [e2e/workspace.spec.ts](e2e/workspace.spec.ts) | Real folder selection, recent-workspace switching, source preservation, and restart recovery. |
| [e2e/shared.spec.ts](e2e/shared.spec.ts) | Shared desktop, cache/checkpoints, independent Host lifecycle, and opt-in real semantic fork. |

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

Third-party attribution is recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
The application does not claim VS Code or GitHub Copilot affiliation.