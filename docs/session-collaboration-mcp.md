# Session collaboration MCP

Task Continuum provides a dedicated **MCP stdio server** (`taskcontinuum-collab-mcp.cjs`)
for coordinating Agent Host sessions linked to the same task across local and paired
remote machines. It uses the running desktop's task repository bindings, collaboration
policy, and authenticated Dev Tunnel + SSH Agent Host gateway — keeping read-only file
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

## Task collaboration settings

Collaboration is **on by default** for every task, without a separate confirmation
or enable step. The workspace still needs **Automatic workspace links**, and the
Agent must use a configured collaboration MCP client. Only currently linked and
authorized sessions are available, and reading or sending still requires the
corresponding permission. Pairing alone does not grant access to unlinked chats,
and enabling collaboration does not itself send any messages.

In **Agent Host sessions > Current**, you can pause, resume, or disable collaboration
for an individual task, or reset its quota after reviewing message activity.
Previously saved disabled and paused settings stay in effect. Disabling collaboration
blocks queued messages without replaying them.

## Install in the actual MCP Host/client

Configure the execution Host/client running beside your Task Continuum desktop to launch
`resources\cli\taskcontinuum-collab-mcp.cjs` (or `out\cli\taskcontinuum-collab-mcp.cjs`
after `npm run build:cli`) with Node.js 24:

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
| `tc_sessions_list` | `taskId` (`T-XXXX`). Lists authorized linked sessions for the task and returns validated `targetRef` handles, location, connection state, and send capability. |
| `tc_sessions_context` | `targetRef`, optional `taskId`, optional `cursor`, optional `limit` (1–20, default 5), optional `detail` (`summary` or `full`). Reads bounded recent turns and marks output `untrustedContent: true`. |
| `tc_messages_send` | `targetRef`, `messageId` (UUID), `text` (up to 12,000 characters), optional `taskId`. Submits an idempotent collaboration message. |
| `tc_messages_status` | `messageId` (UUID). Inspects delivery state and target `turnStatus` without re-sending. |

### Delivery vs. work completion

- `delivered` means the target Agent Host accepted and started turn `turnId` — **not**
  that the receiving Agent has finished its task. Poll `tc_messages_status` until
  `turnStatus` reaches `completed`, then call `tc_sessions_context` to inspect results.
- Busy targets enter `queued` (up to 16 queued messages per task, 30-minute TTL) and
  drain automatically once the active turn completes and authorization still holds.
- Unsent human drafts or uncertain deliveries on the target chat return `blocked` rather
  than overwriting drafts or bypassing manual delivery review.
- Application restarts transition persisted `queued` entries to `blocked` and
  in-flight `dispatching` entries to `uncertain`; prompts are never replayed
  automatically.
