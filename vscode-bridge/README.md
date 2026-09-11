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
   the bridge and remembers authorization for this workspace without sending a
   message. Later VS Code startup or reload restores it automatically. The external-link icon opens the original
   conversation. **Task Continuum: Start VS Code Bridge** remains a manual alternative.
4. Sign in to Copilot in the original VS Code workspace with its existing Agent
   mode/model. Finish existing work and clear any unsent native draft. Sending from
   the updated desktop restores the approved connection and opens this original
   chat only if needed; no separate Connect or Open action is required.
5. Enter a message in Task Continuum. With delivery confirmation enabled, review the
   target session, sender, execution machine, and text in VS Code, then choose
   **Send to original session**. With it disabled, desktop submission sends directly. Tool
   approvals, agent questions, and stopping an executing response remain in VS Code.
6. Run **Task Continuum: Stop VS Code Bridge** to stop accepting deliveries. This
   also disables automatic restoration for this workspace and cancels unconfirmed
   delivery work, not an already-running Copilot response.

Upgrade earlier versions by installing the 0.5.0 VSIX. An already-loaded extension may
need **Developer: Reload Window** before starting the new bridge. Finish active
work first; the desktop does not reload the VS Code window automatically. Both
Task Continuum desktops must load the rebuilt app for the readiness protocol. Connection attempts
retain the current draft and show send-blocking reasons next to the input area.

## Image Sending (0.5.0)

The updated desktop accepts pasted screenshots and selected PNG/JPEG/GIF/WebP
files, including image-only messages. Each request permits four images, 5 MiB
per image and 10 MiB total. Only authenticated send routes accept the larger
image payload; non-send request limits and existing grants remain unchanged.

The execution machine stores validated bytes in its private bridge `images`
directory using content-hash filenames. The original Agent receives file URLs
and is asked to inspect them with its image-reading tool. This is not native
VS Code image-variable injection: the Agent needs the appropriate tool, and
its existing approvals still apply. No focus-dependent attachment command,
new Agent, mode switch, or replacement conversation is introduced.

Receipts store image metadata only. Retry identity includes image hashes and
metadata; a different image cannot reuse the same message ID. The image store
is bounded to 256 MiB and is never placed in task Git metadata. Saved history
sync sends metadata, not image bytes. Both desktops and this Companion must
load the new build; existing workspace enablement and device grants are retained.

## Large Initial Snapshots (0.4.4)

The earlier JSONL reader shared its 32 MiB record limit with legacy JSON files.
Large native initial snapshots can exceed that bound without exceeding the journal
limit, causing `A VS Code journal record exceeds the 32 MiB limit` and an omitted
remote catalog entry. Version 0.4.4 permits individual JSONL records up to 64 MiB;
the complete journal limit stays 256 MiB and legacy JSON stays 32 MiB.

The reader remains read-only and preserves native identity, incremental updates,
draft/busy checks, bounded display history, and partial-tail handling. No history
is deleted, imported, or replayed. Both the source Task Continuum desktop and this
companion must load the updated reader. Finish active work before reloading VS Code;
existing device pairings and workspace consent are retained.

Verification includes a 44 MiB initial-record regression, oversize rejection, actual
read-only recovery of the failing original, Electron history/update/restart checks,
and an isolated installed-VS-Code SSH read/open test without model requests.

## Single-action Sending

Version 0.4.3 makes Send prepare the approved original session before submitting
that one message. The desktop restores an existing remote connection, or requests
local Bridge restoration and waits up to twenty seconds. It rechecks the captured
workspace, owner and window after connecting. Initial consent and pairing are not
bypassed; existing 0.4.1 enablement remains valid.

If the exact widget is closed, the companion checks saved history, Agent mode,
drafts, busy state and pending/uncertain receipts before opening it. Opening is
serialized and verified within ten seconds; authorization is checked again before
submission. An existing widget is not reopened or moved. A closed widget may be
opened on B as part of Send, without a separate Open confirmation. The owner's
optional delivery-confirmation setting and native tool policy are unchanged.

Reads, browsing and background reconnection never submit a message or open a chat.
Preparation failure leaves the desktop draft intact and sends nothing. Existing
message IDs remain deduplicated, including retries after the original closes.
There is no automatic replay or persistent send queue. Optional manual Open remains.

256 tests, lint/types/build, real Git-owned multi-session SSH, two-desktop one-click
reconnection and automatic opening, and installed VS Code 1.137 deterministic
delivery to a previously unopened 40 MiB journal passed. Other conversations were
unchanged. Desktop/420px screenshots were reviewed. No production user prompt or
cloud request was used. Both desktops and the companion must load the new build.

## Previous View Readiness (0.4.2)

Version 0.4.2 reports whether the exact original chat widget is present, separately
from Bridge connectivity and saved Agent state. A closed original remains readable
and connected, but **Session not open** disables sending and offers an explicit
open action. Opening waits up to ten seconds for that exact view, not merely the
native command's return. An existing view still receives the explicit open command.
Stop cancels readiness waits; reads and sends never open or replay anything.

The version-gated probe calls `workbench.action.chat.executeHandoff` with the exact
`sessionResource`, no label or prompt, and ID `taskcontinuum-widget-presence`. In
the inspected native implementation every real handoff ID is `agent:label-slug`,
so this colon-free ID cannot match a handoff. Widget lookup precedes handoff lookup;
only the known missing-widget or missing-handoff results are accepted. Unknown
results fail closed. No actual handoff, model request, draft edit, or mode switch
occurs. Sending checks again before preparation and immediately before dispatch.

Verification passed 244 tests, lint/types/build, real VS Code 1.137.0 local/SSH
deterministic delivery, and a synthetic journal over 40 MiB with a 28 MiB initial
record. Closed/open/reclosed/reopened states, silent-open rejection, deduplication,
draft retention and other-session isolation are covered. This does not certify the
user's particular production conversation; no failed user message was replayed.

## Automatic Local Connection

Version 0.4.1 activates after VS Code startup and restores only workspaces previously
enabled through **Connect** or **Start VS Code Bridge**. Consent is kept in the
extension's private `workspaceState`, not Git or a shared workspace setting. Existing
0.4.0 workspaces need one explicit connection to establish this remembered choice.

Cold-start readiness failures retry up to three times with 5/10/15-second delays.
Stop cancels pending restoration and clears remembered enablement; shutdown alone
retains it. Untrusted, remote, virtual, and unverified-version workspaces do not
auto-start. The desktop still requires the original VS Code window to be running.
Automatic connection does not open a conversation, send/replay prompts, start an
Agent, or grant remote access. A saved conversation must be explicitly opened before
sending if its chat widget is not already present.

VS Code 1.136.x and 1.137.x are supported. After the local installation updated to
1.137.0, the old version guard rejected connection before consent. The exact-session
commands, deterministic delivery, remote opening, and remembered restart/Stop behavior
were verified with isolated installed VS Code 1.137.0. Unknown versions remain blocked.

## Remote access over SSH

Version 0.4.0 adds an explicit `/remote/open` operation for the exact authorized
session, restricted to read/send grants. A confirms **Open session on B** before
the owner opens the original chat as an editor. The operation serializes opens,
rejects pending/uncertain target deliveries, and rechecks grant validity before
opening and returning. Read-only grants cannot change the owner's UI.
Opening never sends; the existing send guards remain unchanged. The desktop refreshes
saved state afterward, and the user submits a message separately. A new optional
`canOpenRemote` field advertises capability; upgrade both desktops as well as B's Bridge.

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
plus explicit read/write-authorized opening of that exact session. They do not allow
local administration, other chats, unrelated window control, or arbitrary commands.
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