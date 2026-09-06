# Task Continuum

A focused Electron workbench for tasks and the conversations that move them forward.
Familiar VS Code-style navigation, without an editor, extension host, terminal, or debugger.

**T-0002 + T-0003 local session MVP.** The desktop can connect to GitHub Copilot,
resume native CLI sessions, and continue reviewed VS Code text history in a new
Copilot session. Task records are still explicitly labeled sample data.
Remote hosts, SSH rooms, OneDrive, and repository synchronization are not connected.

## What works

- Activity bar, task explorer, open-task tabs, task viewer, chat, and status bar.
- Search by task ID, title, or owner; filter by status; collapse the task group.
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
- Persisted native history, reviewed imports, and per-task session bindings.

## Requirements

- Node.js 24 LTS and npm. Verified with Node 24.14.1 and npm 11.11.0 on Windows.
- Internet access for the initial dependency and Electron runtime download.
- A graphical desktop for Electron smoke tests. Offline tests need no model account.
- Real chat requires an authorized Copilot account and network access to its service.
    The official SDK 1.0.13 includes runtime 1.0.83 and reuses local authentication.
    Sign in directly through the Copilot CLI when required; never put tokens in the UI.

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

## Keyboard

| Shortcut | Action |
| --- | --- |
| Ctrl/Command+P | Quick-open a task. |
| Ctrl/Command+B | Toggle the task sidebar. |
| Ctrl/Command+Alt+B | Toggle chat. |
| Left/Right on a tab | Switch open tasks or document views. |
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
| [src/shared/sessions.ts](src/shared/sessions.ts) | Structured-clone-safe session, event, and preload contracts. |
| [src/shared/chat.ts](src/shared/chat.ts) | UI/session adapter contract: task snapshot, history, cancellation, typed stream events. |
| [src/renderer/App.tsx](src/renderer/App.tsx) | Workbench composition, navigation, dialogs, and shortcuts. |
| [src/renderer/chat/useTaskChats.ts](src/renderer/chat/useTaskChats.ts) | Per-task draft/message state and request cancellation. |
| [src/renderer/chat/demoAdapter.ts](src/renderer/chat/demoAdapter.ts) | Deterministic, network-free demo responses, not an LLM. |
| [src/renderer/chat/copilotAdapter.ts](src/renderer/chat/copilotAdapter.ts) | Request-scoped desktop event streams; never a silent demo fallback. |
| [src/renderer/data/tasks.ts](src/renderer/data/tasks.ts) | Sample data, not a read of the planning workspace. |
| [e2e/desktop.spec.ts](e2e/desktop.spec.ts) | Production Electron smoke and isolation checks. |
| [e2e/copilot.spec.ts](e2e/copilot.spec.ts) | Read-only imports, restricted IPC, narrow layouts, and opt-in real Copilot continuity. |

The renderer has no Node types or Node integration. Test code has a separate mixed
Node/DOM type environment. Production serves allowlisted assets under a custom
local protocol, blocks network requests with CSP, denies popup/navigation and
permission requests, and never exposes generic IPC, filesystem, or shell APIs.
Development permits only the additional script/connection behavior required by Vite.

## Data and boundaries

Native sessions persist in the SDK's local Copilot home, normally `~/.copilot`.
Reviewed text snapshots are saved atomically in the desktop profile's
`copilot-imports.json`. Renderer storage retains preferences and task/session IDs
and titles. Task fixtures, local task edits, demo messages, and drafts remain ephemeral.
Detaching a conversation removes its UI binding; it does not delete native history.

The runtime uses SDK-owned stdio, with no additional listening port. Its permissions
are requested from the desktop user, not automatically approved. Existing local
authentication is reused; credentials and the SDK stay outside the renderer.
External CLI writers must be idle before resume; cross-process ownership leases,
remote collaboration, shared rooms, OneDrive, and GitHub EMU synchronization remain deferred.

Optional launch environment variables:

| Variable | Purpose |
|---|---|
| `TASKCONTINUUM_DATA_DIR` | Override the desktop profile, including reviewed imports and UI bindings. |
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

Third-party attribution is recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
The application does not claim VS Code or GitHub Copilot affiliation.