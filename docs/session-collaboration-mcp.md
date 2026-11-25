# TaskContinuum agent tools

**TaskContinuum** is the tool namespace. **Collaboration** is its first capability
group, for coordinating Agent Host sessions across tasks in one workspace,
including on paired remote machines. The native Agent Host and MCP transports use
the same tool definitions and workspace authorization. The standalone, read-only
file transfer server (`taskcontinuum-files-mcp.cjs`) is unchanged.

## Use in a native Copilot Agent Host session: no MCP setup

1. In Task Continuum, open a linked Copilot Agent Host chat in your task
   workspace. It can be a local chat or a remote chat that already grants
   your device send access. No owner-side view is needed for a remote chat.
2. Ask that chat to **list the sessions it can collaborate with**, or to
   send a message to another linked chat. If you also use VS Code to send a
   prompt locally, keep the same chat open in Task Continuum. No MCP config,
   external Node process, or additional enrollment step is needed.

The native route uses AHP 1.0 client tools. TC publishes one contribution per
session with `session/activeClientSet` and consumes only running calls assigned
to its own client. The originating chat must be attached and currently confirmed
in a single workspace; a call cannot supply its own workspace or sender.
Native tool approvals remain in the Host. Closing the last view removes the
contribution; reconnect registers it again without replaying calls.

For a remote-origin turn, the owner Host runs the agent but sends the tool
call back on the exact authenticated gateway connection that started the turn.
The caller's TC locates targets and runs tools in the caller's workspace using
its existing read/send permissions. The owner does not grant access to chats
the caller could not already reach. No arbitrary tool definition, filesystem
operation, or workspace path is forwarded. Keep both TC desktops updated.
If the connection drops, pending tool calls fail rather than replaying on
another connection; start a new turn if needed. The MCP route remains
available for agent clients outside this native attachment flow.

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
links**, and the sending Agent needs either the native attachment above or a
configured TaskContinuum MCP client.
Only sessions currently linked and authorized in that workspace are available.
Their tasks do not have to match. Reading or sending still requires the
corresponding permission. Making tools available does not send any messages.

## TaskContinuum MCP: optional fallback

Configure the execution Host/client running beside your Task Continuum desktop to launch
`resources\cli\taskcontinuum-mcp.cjs` (or `out\cli\taskcontinuum-mcp.cjs`
after `npm run build:cli`) with Node.js 24. Use the MCP executable from the same
build as the local desktop, and restart the MCP client after updating.

Example for Copilot Global (the editor-only legacy config uses `servers` instead
of `mcpServers`):

```json
{
  "mcpServers": {
    "taskcontinuum": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\Tools\\TaskContinuum\\resources\\cli\\taskcontinuum-mcp.cjs"
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
descriptor. Existing `taskcontinuum-collab-mcp.cjs` configurations and `tc_*`
tool names continue to work; new setups should use the product-wide entry.

## Tools and delivery semantics

| Tool | Arguments |
| --- | --- |
| `taskcontinuum_collaboration_list_sessions` | Optional `taskId`, `query`, `limit` (1–20, default 20), and `offset`. Searches authorized linked sessions in the workspace. Each row has its own `taskId`, `targetRef`, device, connection state, and send capability. |
| `taskcontinuum_collaboration_read_context` | `targetRef`, optional `cursor`, optional `limit` (1–20, default 5), optional `detail` (`summary` or `full`). Reads bounded recent turns and marks output `untrustedContent: true`. |
| `taskcontinuum_collaboration_send_message` | `targetRef`, `messageId` (UUID), and `text` (up to 12,000 characters). Submits an idempotent collaboration message. |
| `taskcontinuum_collaboration_message_status` | `messageId` (UUID). Inspects delivery state and target `turnStatus` without re-sending. |

### Find a session

Pass the caller's `taskId` to start with that task, then search its descendants
(direct children first), its ancestors (nearest parent first), and all other
workspace tasks. The task only changes the order. Omit it to browse the workspace.
`query` matches task IDs and titles, machine names, session and chat IDs, and
session titles when available. Search does not open remote chats to fetch titles.

For example, `taskcontinuum_collaboration_list_sessions({ "taskId": "T-0072", "query": "Runner3", "limit": 5 })`
can return sessions linked under tasks other than T-0072. Follow `nextOffset`
with the same task and query until it is absent. Use the returned `targetRef`
unchanged in read and send calls; any optional caller `taskId` on those calls
does not select or restrict the destination. Do not construct a reference
from Git bindings: sending still requires authorization for the exact chat.
Once you have the target, call `send_message` directly; loading its history
is not required.

### Delivery vs. work completion

- `delivered` means the target Agent Host accepted and started turn `turnId` — **not**
  that the receiving Agent has finished its task. Poll
  `taskcontinuum_collaboration_message_status` until `turnStatus` reaches
  `completed`, then call `taskcontinuum_collaboration_read_context` to inspect results.
- Busy targets enter `queued` (up to 16 queued messages per task, 30-minute TTL) and
  drain automatically once the active turn completes and authorization still holds.
  A full queue returns `BUSY`; it frees capacity as pending messages finish or expire.
- Unsent human drafts or uncertain deliveries on the target chat return `blocked` rather
  than overwriting drafts or bypassing manual delivery review.
- Application restarts transition persisted `queued` entries to `blocked` and
  in-flight `dispatching` entries to `uncertain`; prompts are never replayed
  automatically.
