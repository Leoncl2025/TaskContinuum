# Task Continuum

A focused desktop workbench for tasks and native Copilot Agent Host conversations.

## Features

- **Smooth cross-device session switching:** move between local and remote
  conversations while preserving each session's draft in memory.
- Multiple conversations per task.
- Searchable task trees, task tabs, and read-only planning documents.
- Task creation through the UI, a local agent, or CLI.
- Streaming Markdown, model options, image attachments, and terminal output.
- Collapsible tool activity keeps answers readable without losing execution details.
- Compact layouts, resizable panels, dark/light themes, and cached chat titles.
- Native full screen: press **F11** or **Shift+Alt+Enter**, or use the titlebar's
  full-screen button, to fill the monitor and hide the Windows taskbar. Repeat to
  exit; window size and maximized state are restored. This does not change the
  system's taskbar settings. Escape keeps its normal dialog/chat behavior.

## Download

Get the Windows x64 installer or ZIP from
[GitHub Releases](https://github.com/Leoncl2025/TaskContinuum/releases).
Extract the entire ZIP before launching. Current releases are unsigned; verify
the published SHA-256 checksums. Electron is bundled, so launching requires
neither Node.js nor npm. Repository operations require Git.

## Get started

Open the workspace folder containing `.agentdesk/config.json`, or choose
**Create task repository**.

Use **New task** to create and publish generated task files to the configured
Git upstream. If publication fails, retain the local task rather than recreating
it. CLI creation remains local. Refresh after external edits.

## Agent Host Sessions

Chat requires a running VS Code Agent Host supporting **AHP 0.9.0** and an
authorized Copilot provider on the execution machine.

Enable **Automatic workspace links**, then use:

- **Current** to open or unlink task conversations.
- **Link** to attach an existing chat.
- **Create** to explicitly create a chat.

Choose a model beside the composer. Approvals remain on the owner machine.
Reconnection preserves the original session and never automatically replays
messages. Unlinking does not delete history. Unsent drafts are not guaranteed
across restarts.

Consecutive routine tool calls appear in one collapsed activity row with a count
and a live running summary. Expand it to inspect the original calls and their
outputs; terminal output still loads on demand. Failures, cancellations, approval
or authentication requests, and input prompts stay outside these groups. Text
answers keep their original position, and reasoning remains separately collapsible.

## Automatic workspace links

Remote access uses Microsoft Dev Tunnels and restricted SSH, requiring the
same Microsoft work-account owner on both devices and OS secure storage.
Install the official Dev Tunnel CLI; no OS SSH server is required.

Signed workspace metadata synchronizes through Git. Pairing, permissions, and
owner confirmation remain mandatory. Chat history, images, and credentials stay
outside Git. See [setup and recovery](docs/remote-vscode.md) and
[workspace synchronization](docs/workspace-git-sync.md).

## Development

With Node.js 24 and npm:

```powershell
npm ci
npm run dev
```

Use `npm run check` for validation, `npm run test:e2e` for desktop tests, and
`npm run dist:win` for packaging.

### Isolated AHP proof of concept

[Opt-in native Host test](e2e/ahp.spec.ts).

## Documentation

- [Task documents and CLI](docs/task-documents.md)
- [File transfer MCP](docs/file-transfer-mcp.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

An independent project, not affiliated with VS Code or GitHub Copilot.
