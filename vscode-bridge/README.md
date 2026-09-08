# Task Continuum Bridge

Companion on the execution machine for local or remote Task Continuum desktops. It opens an existing Copilot Chat
conversation in its original VS Code workspace and delivers explicitly submitted
messages to that session. It does not import, fork, or start a CLI conversation.
Replies identify the execution machine; user messages identify their sender.

## Use

1. Install the locally built VSIX with **Extensions: Install from VSIX**.
2. Open the original conversation's workspace in VS Code and leave that window
   foremost among your VS Code windows.
3. In Task Continuum, preview the VS Code conversation, choose **Link to current
   task**, then **Connect VS Code**. Confirm **Connect** in VS Code. This starts
   the bridge without sending a message. The external-link icon opens the original
   conversation. **Task Continuum: Start VS Code Bridge** remains a manual alternative.
4. Sign in to Copilot in VS Code and keep the original chat open in its current
   sidebar or editor with the original Agent mode/model. Finish existing work and
   clear any unsent draft before sending from the desktop.
5. Enter a message in Task Continuum. With delivery confirmation enabled, review the
   target session, sender, execution machine, and text in VS Code, then choose
   **Send to original session**. With it disabled, desktop submission sends directly. Tool
   approvals, agent questions, and stopping an executing response remain in VS Code.
6. Run **Task Continuum: Stop VS Code Bridge** to stop accepting deliveries. This
   cancels unconfirmed delivery work, not an already-running Copilot response.

Upgrade earlier versions by installing the 0.3.0 VSIX. An already-loaded extension may
need **Developer: Reload Window** before starting the new bridge. Finish active
work first; the desktop does not reload the VS Code window automatically. Reopen
an older Task Continuum desktop to load its connection button. Connection attempts
retain the current draft and show send-blocking reasons next to the input area.

## Remote access over SSH

Version 0.3.0 supports clients A/C connecting to this machine B's same original
VS Code GitHub Copilot session. B still runs a local, trusted VS Code 1.136.x
workspace; this does not enable Remote SSH/WSL/container VS Code windows.

1. On A's current Task Continuum desktop, open a task workspace and use the
   activity-bar **Remote VS Code sessions** icon to **Export client identity**.
2. On B, connect the original chat as above and click **Share original conversation
   remotely** in its Task Continuum chat panel. Choose read-only or read/send access,
   select A's exported identity, and confirm the recipient and original conversation.
3. Save the private invitation outside Git and transfer it securely to A. A imports
   it with an independently configured SSH alias, explicitly connects, and links
   its selected task. A needs neither local B history nor CLI sign-in.

The companion binds only to loopback. Provision SSH public-key authentication,
verified host keys, forwarding permissions, and approved firewall/network access
separately. Task Continuum does not install services or change those policies.
Remote tokens allow only the approved session's history and permitted sends,
not local administration, other chats, opening/moving windows, or arbitrary commands.
Owner-approved username/client-machine labels are distinct from B's execution
hostname; possession of the invitation is authority, not hardware attestation.

Invitations expire in 24 hours or when the bridge stops. B can revoke individual
grants in the remote-access dialog. Revocation rejects future operations and cancels
unconfirmed delivery waits, not an already-executing Agent. A's disconnect or exit
closes its tunnel only. Cached history is read-only; restart never auto-connects
or replays. A matching renewed invitation must be imported after B restarts.
Native questions, cancellation, and tool approvals stay in B's VS Code. The existing
extra-send-confirmation preference applies to remote messages without alteration.
Treat private invitations, delivery journals, and caches as sensitive data.

## Optional Send Confirmation

Version 0.2.5 adds `taskcontinuum.confirmOriginalSessionSend` (default `true`). Set
it to `false` in this machine's VS Code User settings to omit the extra **Send to
original session** popup. The desktop's Send action remains the explicit submission.
This is a machine-scoped preference, not a setting a task repository can disable.
It is read for each message; changing it does not require restarting the bridge
once 0.2.5 is loaded. Re-enable it with `true` at any time.

Connection consent, workspace trust, original-session/Agent identity, busy/draft
checks, cache readiness, no-replay rules, and Copilot's tool approvals are unchanged.
The installed-VS-Code regression verifies a default-confirmed first message and a
second distinct message with the setting disabled, no popup, native persistence,
unchanged layout, and no unintended messages in the other conversation.

## Previous Updates

Version 0.2.6 reads long JSONL histories record by record instead of rejecting the
whole file above 32 MiB. The limits are 32 MiB per record and 256 MiB per journal;
legacy JSON retains its 32 MiB file limit. The reader shares the latest unchanged
file revision between repeated requests, and invalidates it on file identity, size,
or timestamp changes. Source histories remain read-only. Both the desktop and the
companion must load the updated reader to use a long original conversation. This
does not reset the original session, change bindings, or alter confirmation settings.

Version 0.2.4 explicitly invalidates the contributed-Agent cache after each template
write and restoration. The contribution declares `taskcontinuum.deliveryRevision >= 0`;
the bridge updates only that extension-owned context key using `setContext`. VS Code
observes changes to a contribution's `when` keys, so freshness no longer depends only
on file notifications or an unrelated customization refresh. User settings and workbench
files are not changed. Stable names and exact URI/handoff/text/target checks remain.

Before starting the sending bridge, connection now verifies a unique `send: false`
readiness handoff under the existing template lock, then restores the original template.
It never invokes the handoff command, opens a chat, or writes a delivery record. A
failed check reports its mismatch in VS Code and does not start the bridge. Successful
connection is evidence of template readiness at that time, not authenticated Copilot
execution; each later message still has strict checks and follows its configured
delivery-confirmation preference.

The user's continued failure on 0.2.3 showed that its isolated successes did not prove
the actual environment was repaired. The 0.2.4 checks pass with file watching excluded:
no-message connection, two distinct native deliveries, and unchanged layout. A negative
control without the context condition still received an unrelated refresh and was not
retained as proof of causality. The current user's environment has not been reloaded or
probed with 0.2.4 automatically. Do not replay earlier failed or pending messages.

Version 0.2.3 keeps the registered delivery template name stable and updates its
content through the VS Code file service. A repeated-delivery regression reproduced
the earlier failure: the Agent provider could retain a registered display name while
the sender expected a newly renamed Agent for every message. Delivery now requires
the exact private file URI, unique handoff label, complete prompt, original target
Agent, and `send: true`; a display-name change is not a message acknowledgment.
Stale or incorrect handoff contents still fail without dispatch. Errors distinguish
missing registration, stale handoff, text mismatch, target mismatch, and disabled
auto-send without including message contents. Failed records are not replayed.

Version 0.2.2 no longer opens or moves a conversation as part of sending. Earlier
versions automatically opened it as an editor, leaving its old sidebar empty and
changing the visible layout before the delivery outcome was known. The sender now
addresses the existing widget by its exact session URI; a missing widget returns an
error without opening another conversation. Template-load failures do not move it.
The explicit external-link action still opens as an editor. To restore a previously
moved conversation, focus its editor and run **Chat: Move Chat into Side Bar**. The
repair does not reset your layout or replay the failed message automatically.

The bridge starts only by explicit command or a confirmed desktop connection. Its
`onUri` handler accepts only `/connect` and the exact workspace/session IDs, validates
that the original exists, and requires confirmation before startup. It accepts no
message, arbitrary command, credentials, or filesystem path. VS Code delivers the
URI to the topmost window; a mismatching workspace is rejected rather than switched.
A reload stops the bridge. It binds to loopback,
uses a per-run private credential, and accepts only existing sessions from this
workspace. The private discovery record stays in VS Code workspace storage, never
the task repository. It exposes identity/open/send/delivery-status operations, not
shell access, generic commands, or automatic tool approvals. The sender name is
the bridge OS user's name for local sends and the owner-approved grant participant
for remote sends. No identity can be overridden in a message body.

Messages are journaled before delivery. Retries reuse their command ID; uncertain
deliveries and bridge restarts never replay automatically. The original request ID
is confirmed from VS Code's persisted history. VS Code typically saves about once
per minute, so desktop replies and confirmation can lag the VS Code UI. A submitted
message is not a completed Agent turn. The journal is limited to 500 deliveries
and 4 MB per source workspace. Missing historical authors/machines remain unknown.

This compatibility adapter is limited to VS Code 1.136.x and requires a local,
trusted workspace. Other versions fail closed until verified. It uses the internal
`workbench.action.chat.executeHandoff` command with an explicit `sessionResource`,
not the focused-widget Send command. A temporary extension-owned handoff targets
the original Agent mode; it is not selected as the execution Agent. Its payload is
cleared after delivery under a cross-window lock. Do not select the private delivery
template manually. After a crash, verify the original process stopped before clearing
a reported stale template lock; review private template data before sharing diagnostics.

This is a compatibility adapter, not a supported public session-control API or
distributed ownership lock. Do not edit the original chat, its draft, mode, or
model while confirming a delivery; the bridge checks saved state, which can lag
live edits. Existing model access and tool policies are not bypassed. No desktop
stop/approval forwarding, remote/virtual windows, or automatic replay is provided.
Keep all installed extensions and the local OS profile trusted.

Verification uses real VS Code and an explicitly named deterministic test participant
in isolated sessions using a normally installed extension under an OS temporary
directory, cleaned when the test ends. It starts the bridge from the desktop
connection URI and checks that a sidebar original receives the request without
replacing another editor conversation or changing tabs, groups, and panel bounds.
The 0.2.3 regression preloads the Agent cache, sends two different messages in the
same window, and verifies distinct new native request IDs, complete replies, exact
second-message text, duplicate-command handling, other-session isolation, unchanged
layout, and restored empty template. Test participants are not sticky, so they do
not introduce an artificial `@participant` draft between submissions.
It also checks exact-session delivery, reply persistence, sender
and execution-machine attribution. Version 0.3.0 routes the second distinct request
over real system OpenSSH from an enrolled client with no local source history.
The native ID, remote username, execution host, other-chat isolation, and layout
remain verified. The latest 202 unit/component tests, lint, types, and
production build passed. This does not certify
an authenticated production Copilot model response; that requires the user's signed-in
VS Code environment. The test participant/model is not packaged in this extension.

This project is independent of Microsoft and GitHub. The component is for local
development use; no marketplace publication or standalone installer is provided.