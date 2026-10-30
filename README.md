# Task Continuum

A focused desktop workbench for tasks and native Copilot Agent Host conversations.

## Features

- **Smooth cross-device session switching:** move between local and remote
  conversations while preserving each session's draft in memory.
- Multiple conversations per task.
- Device-local restoration of open task tabs, the active task and each task's selected chat.
- Searchable task trees, task tabs, and read-only planning documents.
- **Ctrl+PageUp / Ctrl+PageDown** switches to the previous/next open task tab,
  wrapping at either end without clearing chat drafts.
- Selecting a task or session opens its chat pane and automatically focuses the
  message input, preserving drafts and the caret. Background updates do not steal
  focus, and open dialogs keep control; selecting an unlinked task creates no chat.
- Task creation through the UI, a local agent, or CLI.
- Streaming Markdown, model options, image attachments, and terminal output.
- Message text supports up to **12,000 characters** (UTF-16 code units), with the
  same limit for local and remote chats. Task-creation chats include generated
  guidance in their first-message budget. Update both desktops to use the higher
  limit in remote chats.
- Inline and block math in chats and task documents, rendered offline with KaTeX.
- Clickable web links and source-owned file links, with authenticated remote
  transfer, client-side previews, local document opening and copyable link addresses.
- Collapsible tool activity keeps answers readable without losing execution details.
- Compact layouts, resizable panels, dark/light themes, and cached chat titles.
- Copilot-inspired neutral surfaces, rounded controls and message cards, and a
  softly elevated composer with a thin gray focus border. The light theme uses the
  selected "Sky & Lemon" palette: blue primary actions, lemon Task selection,
  sky-blue user messages, apricot notes, and subtle purple feature chips.
  Secondary controls and text selection stay neutral; green remains reserved for
  success states. Web and file links retain their separate blue palette, including
  linked bold and inline-code labels. New profiles start in light mode; saved
  theme preferences and the existing dark palette are preserved.
- Native full screen: press **F11** or **Shift+Alt+Enter**, or use the titlebar's
  full-screen button, to fill the monitor and hide the Windows taskbar. Repeat to
  exit; window size and maximized state are restored. This does not change the
  system's taskbar settings. Escape keeps its normal dialog/chat behavior.
  Off-screen history skips layout during resizing without removing messages or
  resetting expanded tool/reasoning state. A chat following the latest reply stays
  at the bottom across full-screen and panel-size changes; browsing earlier
  messages does not jump back to the latest reply.

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

Chat requires a running VS Code Agent Host negotiating **AHP 1.0.0, 0.10.0, or 0.9.0** and an
authorized Copilot provider on the execution machine.
Host discovery versions are not treated as the negotiated wire version.
See [protocol compatibility](docs/remote-vscode.md#protocol-compatibility) before
upgrading a multi-device setup; existing sessions and bindings are retained.

Enable **Automatic workspace links**, then use:

- **Current** to open or unlink task conversations.
- **Link** to attach an existing chat.
- **Create** to explicitly create a chat.

Choose a model beside the composer. Approvals remain on the owner machine.
Reconnection preserves the original session and never automatically replays
messages. Unlinking does not delete history. Unsent drafts are not guaranteed
across restarts.

Restarting Task Continuum or reopening a workspace restores all task tabs that
were still open, in the same order, along with the active task and its exact
linked chat, including the owner, session and chat identities. Closed tabs are
not reopened, and tasks removed from the workspace are skipped.
The selection is stored only in this device's application profile, separately for
each workspace; it is not written to task files, Git or another device. The first
task/chat remains the default when nothing has been remembered.
Restoration waits for current bindings and uses normal Host authorization. An
offline chat stays selected; an unlinked or replaced chat is not silently
substituted. Choose another chat from **Current** if the saved one is no longer
linked. Missing tasks fall back to the first available task, and closing all task
tabs or unlinking the selected chat retains that explicit empty selection.
The previous active-only preference is read without losing its task/session
selection; other tabs can be remembered once opened in this version.
Only tab and selection identifiers are saved, not drafts, messages, credentials or
permissions. Storage failures are reported while current navigation remains
usable.

### Clickable links

HTTP(S) links in chats and task documents open in your default browser only when
clicked. File links in a chat use that chat's original execution owner: remote
files are fetched through the existing paired-device file-transfer service, not
looked up on the receiving machine. Absolute paths and `file:` URLs are supported;
relative links use the original chat's single verified working directory.

Received text and supported images open in a read-only preview with progress,
cancel and **Save local copy**. **Save and open locally** writes a verified copy
to a client-selected destination, then opens supported documents/images in that
client's default application. Executables and scripts stay preview/save-only.
Private application files remain blocked, and pairing and current chat access
are revalidated. See [file-link behavior](docs/remote-vscode.md#clickable-chat-links).

Copying selected chat text preserves hyperlinks as Markdown URLs in plain text
and as links in rich text. Right-click a link for **Copy link address**. Both copy
the original URL, not the client's temporary file-transfer path. Code-only copying
and formula rendering keep their existing behavior.

Sent screenshots are shown even when the Host replaces embedded image bytes
with a `resource` file reference. Embedded images show thumbnails directly;
file-backed screenshots show a **Preview** card that fetches the image from the
original chat owner on click. Reopening old messages uses the same behavior.
Invalid, missing or unsupported image data is reported instead of disappearing.

Consecutive routine tool calls appear in one collapsed activity row with a count
and a live running summary. Expand it to inspect the original calls and their
outputs; terminal output still loads on demand. Failures, cancellations, approval
or authentication requests, and input prompts stay outside these groups. Text
answers keep their original position, and reasoning remains separately collapsible.

Math supports `\( ... \)` / `\[ ... \]`, `$...$` / `$$ ... $$`, and fenced `math`
blocks. Formulas inside tables keep their cell boundaries, including `|D|`.
Ordinary code samples stay literal. Invalid or unfinished formulas remain readable;
long display formulas scroll within the message. See [math rendering](docs/remote-vscode.md#math-in-messages-and-task-documents).

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
