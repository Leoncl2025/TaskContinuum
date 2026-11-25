# Session collaboration MCP

Task Continuum provides a dedicated **MCP stdio server** (`taskcontinuum-collab-mcp.cjs`)
for coordinating Agent Host sessions across tasks in one workspace, including on
paired remote machines. It uses the running desktop's task repository bindings and
authenticated Dev Tunnel + SSH Agent Host gateway — keeping read-only file
transfer (`taskcontinuum-files-mcp.cjs`) separate from session execution authority.

## Collaboration UI and native session provenance

Task Continuum also adapts its chat and session UI for both native VS Code cross-session
messages and Task Continuum cross-machine collaboration:

- **Message provenance:** Human messages keep the user bubble, while native Agent-origin
  messages (`origin.kind === "agent"` with `vscode.chat.delegation`) and Task Continuum
  collaboration messages (`_meta.taskcontinuumCollaboration`) render with distinct
  agent-origin styling and provenance headers.
- **Authorized source navigation:** When a message's source chat/session matches a
  currently linked, authorized session in the workspace, its provenance badge opens that
  linked session. Unlinked or cross-owner claims remain plain labels and never auto-link
  or open unauthorized chats.
- **Pending queue & tool summaries:** Queued and steering messages appear in a dedicated
  pending section, collaboration tool calls display concise status summaries, and new
  background activity while reading older history shows a non-intrusive **New activity
  below** pill instead of stealing focus or scroll position.

## Availability

Collaboration is **available by default** across tasks in the configured workspace.
There is no separate collaboration panel, opt-in, or cumulative send quota. The app ignores old
per-task collaboration settings. The workspace still needs **Automatic workspace
links**, and the sending Agent needs a configured collaboration MCP client.
Only sessions currently linked and authorized in that workspace are available.
Their tasks do not have to match. Reading or sending still requires the
corresponding permission. Making tools available does not send any messages.

## Install in the actual MCP Host/client

Configure the execution Host/client running beside your Task Continuum desktop to launch
`resources\cli\taskcontinuum-collab-mcp.cjs` (or `out\cli\taskcontinuum-collab-mcp.cjs`
after `npm run build:cli`) with Node.js 24. Use the MCP executable from the same
build as the local desktop, and restart the MCP client after updating.

Example configuration (for VS Code, use `servers` instead of `mcpServers`):

```json
{
  "mcpServers": {
    "taskcontinuum-collaboration": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\Tools\\TaskContinuum\\resources\\cli\\taskcontinuum-collab-mcp.cjs"
      ],
      "env": {
        "TASKCONTINUUM_WORKSPACE": "C:\\Work\\Tasks",
        "TASKCONTINUUM_DATA_DIR": "C:\\Users\\you\\AppData\\Roaming\\Task Continuum"
      }
    }
  }
}
```

Do not pass credentials or command-line arguments. The stdio process authenticates to
the local desktop through the owner-private `session-collaboration-mcp.json` loopback
descriptor.

## Tools and delivery semantics

| Tool | Arguments |
| --- | --- |
| `tc_sessions_list` | Optional `taskId`, `query`, `limit` (1–20, default 20), and `offset`. Searches authorized linked sessions in the workspace. Each row has its own `taskId`, `targetRef`, device, connection state, and send capability. |
| `tc_sessions_context` | `targetRef`, optional `cursor`, optional `limit` (1–20, default 5), optional `detail` (`summary` or `full`). Reads bounded recent turns and marks output `untrustedContent: true`. |
| `tc_messages_send` | `targetRef`, `messageId` (UUID), and `text` (up to 12,000 characters). Submits an idempotent collaboration message. |
| `tc_messages_status` | `messageId` (UUID). Inspects delivery state and target `turnStatus` without re-sending. |

### Find a session

Pass the caller's `taskId` to start with that task, then search its descendants
(direct children first), its ancestors (nearest parent first), and all other
workspace tasks. The task only changes the order. Omit it to browse the workspace.
`query` matches task IDs and titles, machine names, session and chat IDs, and
session titles when available. Search does not open remote chats to fetch titles.

For example, `tc_sessions_list({ "taskId": "T-0072", "query": "Runner3", "limit": 5 })`
can return sessions linked under tasks other than T-0072. Follow `nextOffset`
with the same task and query until it is absent. Use the returned `targetRef`
unchanged in read and send calls; any optional caller `taskId` on those calls
does not select or restrict the destination.

### Delivery vs. work completion

- `delivered` means the target Agent Host accepted and started turn `turnId` — **not**
  that the receiving Agent has finished its task. Poll `tc_messages_status` until
  `turnStatus` reaches `completed`, then call `tc_sessions_context` to inspect results.
- Busy targets enter `queued` (up to 16 queued messages per task, 30-minute TTL) and
  drain automatically once the active turn completes and authorization still holds.
  A full queue returns `BUSY`; it frees capacity as pending messages finish or expire.
- Unsent human drafts or uncertain deliveries on the target chat return `blocked` rather
  than overwriting drafts or bypassing manual delivery review.
- Application restarts transition persisted `queued` entries to `blocked` and
  in-flight `dispatching` entries to `uncertain`; prompts are never replayed
  automatically.
