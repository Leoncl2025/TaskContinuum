# Remote Original VS Code Sessions

Remote mode connects a Task Continuum desktop on A or C to the existing GitHub
Copilot Agent in VS Code on B. It retains the original native session and source
workspace IDs, account, tools, and execution environment. It does not publish a
CLI Host, import history into another runtime, or create a fork.

## Prerequisites

- Both desktops run the current Task Continuum build. B has companion 0.4.3 or
  newer loaded in a trusted, local VS Code 1.136.x or 1.137.x workspace. Verification used
  Windows and VS Code 1.136.1/1.137.0. Remote SSH, WSL, container, and virtual VS Code
  windows on B are not supported; connecting an external desktop to local B is.
- B stays running with its original VS Code workspace, Copilot sign-in, Agent
  mode and model. Send opens the original chat widget if needed. With managed Dev Tunnel, B's Task
  Continuum desktop must also stay open to host the transport. Closing it never
  stops the Agent, but disconnects remote desktops. A needs no Copilot CLI sign-in.

## Automatic Local Bridge

With Companion 0.4.1 loaded in B's original VS Code workspace, confirm **Connect VS
Code** once, or run **Task Continuum: Start VS Code Bridge**. Enablement is remembered
per workspace in VS Code's private extension state. Later startup/reload restores
the authenticated Bridge with bounded readiness retries, without another connection
popup. Upgrading from 0.4.0 needs this one-time enablement; old consent is not guessed.

**Stop VS Code Bridge** clears the choice and cancels startup/retries. Closing VS Code
does not clear it, but the Bridge cannot run while VS Code is closed. Unsupported or
untrusted workspaces remain blocked. The desktop discovers the restored endpoint on
its next refresh; it does not change task links or start a substitute Agent.

Bridge connection and opening a particular chat are separate internally: auto-start
never opens/moves a conversation or sends/replays a message. With 0.4.3, one explicit
Send prepares the connection and exact view. Device policies renew grants after Bridge
restart; legacy session invitations still require re-enrollment.

## Managed Dev Tunnel + SSH (Default)

### Send with one action

After initial pairing and workspace consent, select the linked task, enter the
message and press Send. The app restores the existing connection, opens B's exact
original chat only if it is closed, verifies readiness, and submits once. There is
no separate Connect/Open step or Open confirmation. Existing native delivery/tool
approval preferences remain in effect.

Preparation requires read/send access, idle saved Agent state, no native draft and
no pending/uncertain target delivery. Workspace/owner/window changes during desktop
connection abort submission. B verifies the exact widget and rechecks authorization
after opening; a command return alone is insufficient. A failed preparation retains
the draft without queuing or replaying the message. B must still be running.

Opening a closed original can change B's visible chat; an already-open widget is
not reopened or moved. Browsing a task and background recovery never open a chat or
send a message. Manual **Open session on B** remains optional and retains its explicit
confirmation; it opens the exact original without sending anything.

Install the built `artifacts/taskcontinuum-vscode-bridge-0.4.3.vsix` on B using
**Extensions: Install from VSIX**, finish active work, reload the VS Code window,
and reconnect its Bridge. Both Task Continuum desktops must use the rebuilt app.
Device policies can renew after Bridge restart; legacy single-session invitations
still require renewal. Native approvals, code, and execution remain on B.

An older running desktop does not acquire the new readiness protocol just because
the source was rebuilt. Fully reopen both desktops after preserving drafts, and
load the new companion after active work. Existing 0.4.1 workspace consent is
retained. Historical failed receipts are not deleted or automatically resent.

### Device scope (2026-09-09)

Upgrade both desktops. Use the activity-bar **Remote VS Code sessions** device panel,
not a particular Session's sharing dialog. A exports its managed client identity.
B signs in, selects **Linked-session access** (read/send by default), and clicks
**Pair device**. After native confirmation, pairing enables the selected AD workspace's
linked-session policy and automatically starts the private publication. A imports
the device invitation once, verifies the owner/fingerprint, and enables automatic
connection. No manual Publish step or session-by-session invitation is necessary.

B links an original Session to a Task and commits/pushes the normal Git metadata.
A pulls and opens the Task: the owner Client ID selects an already trusted device;
its SSH connection is established/reused on demand. Git changes refresh approximately
every five seconds in an open workspace; no second Link or Share session action.
Device catalog refresh remains approximately ten seconds. Only opened histories are
transferred, as bounded saved snapshots rather than native-file or token streaming.

Each new binding in `.taskcontinuum/session-bindings.json` includes:

```json
{
  "provider": "vscode-copilot",
  "sessionId": "original-session-id",
  "workspaceStorageId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "owner": {
    "clientId": "00000000-0000-4000-8000-000000000001",
    "machineName": "CPC-lianc-L5CN7"
  }
}
```

This object sits under the Task ID in `bindings`; `schemaVersion` remains 1. The
owner is absolute, not relative to the reader. Old `remoteMachineName` bindings
remain readable. Older app versions may reject the new optional owner field;
upgrade both clients. A Git owner change is not an ownership-transfer protocol.

On B, **Register existing local links** explicitly validates and stamps owner-less
local links, then records local receipts. It never automatically claims Git-pulled
or remote links. Already-paired recipients use **Enable linked sessions** to opt
into this workspace policy. Older device invitations lacking the stable owner
Client ID must be re-exported/imported once. Unlinking a Task, changing its owner,
or disabling workspace access removes derived permission on the next request.

The loopback gateway authorizes every read/send against B's approved workspace,
current Git links, and private local binding receipts, then uses the existing
companion grant and delivery checks. A forged Git link alone cannot authorize a
different local Session. Legacy explicitly granted sessions remain compatible.
The only UI-control action is an explicit read/write-authorized open of that exact
original session; generic commands, private-session enumeration, and arbitrary ports
remain prohibited.
Owner policies and issued grants are encrypted in `remote-vscode-device-host.json`;
client enrollment is encrypted in `remote-vscode-devices.json`, outside Git.
`local-session-link-receipts.json` holds local binding confirmations outside Git.
`remote-vscode-device-cache/` contains private bounded read-only history views.

Enabled publication retries with bounded backoff and restores after desktop restart.
**Stop publication** persists the disabled state. A device explicitly connected by A
can reconnect when its workspace is opened or read again; **Disconnect device** stops
that recovery. No failed or uncertain execution message is automatically resent.
Source sleep/exit still makes the Agent unavailable until B returns. Corrupt/missing
cache returns an explicit empty offline view, not a misleading successful history read.

Removing device access to one session or revoking the whole device rejects future
reads/sends; already accepted prompts and downloaded copies cannot be recalled.
Persistent workspace policies can renew companion grants after Bridge restart, but only for
the exact approved session and participant. B must reconnect the original Bridge;
the gateway never starts a substitute Agent. Expired pairings require fresh pairing.
Resetting the tunnel resource changes its route and requires exporting/importing the
device invitation again. Occupied ports and changed keys fail closed.

This increment does not upload native sessions to OneDrive, transfer ownership,
push/pull Git, or migrate execution to A. Native CLI ownership metadata does not
enable remote original-CLI execution; that route fails locally without a replacement.

The session-invitation instructions below are retained for compatibility. They do
not acquire persistent device scope merely by upgrading the app. An already-lost
legacy in-memory grant cannot be recovered from its expiry timestamp alone.

### Transport requirements

- Install the [official Microsoft Dev Tunnel CLI](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started)
  once on A and B. The dialog opens that installation guide if the CLI is missing.
  **Sign in with Microsoft** uses the CLI's browser-based work-account flow; no
  password, device code, or access token is entered into Task Continuum.
- Sign in as the **same Microsoft work-account owner** on both machines. This
  first increment accepts only owner-private tunnels, not anonymous, tenant-wide,
  group-shared, or cross-owner access. Organization network and service policies
  still apply. Both ends use outbound relay connections; no inbound public IP or
  manually mapped port 22 is needed.
- Task Continuum creates separate host and client Ed25519 identities protected by
  OS secure storage. It hosts a loopback-only SSH server inside the app and uses
  the official Dev Tunnels SDK for the cloud connection. No shell, exec, SFTP,
  arbitrary destination forwarding, OS SSH account, or OS service is provisioned.
  Existing OpenSSH services, firewall rules, and user SSH files remain unchanged.
- Each invitation pins the host and recipient public keys. Device invitations use
  the pairing ID as SSH username, authorized only for the private gateway port;
  legacy invitations use the companion grant ID and exact Bridge port. Per-session
  checks remain enforced after SSH, which encrypts traffic across the relay.
- Device-key export is reusable; each original still requires owner approval,
  either through the device policy or a legacy invitation. This removes manual SSH configuration; it
  does not implement a central ten-machine registry, group policy, or SSH CA.
- Dev Tunnels is a preview service for development/testing with no production SLA.
  It is transport, not a durable message queue or ownership authority. Connection
  recovery never implies prompt replay or execution takeover.

## Windows Sign-in Recovery

Microsoft sign-in uses a temporary **Task Continuum Microsoft sign-in** console on
Windows. Complete the native account or browser verification when requested; the
console closes after login. It is not a terminal that must stay open for SSH. Cancel
and the five-minute login deadline terminate only the app's own login process tree.
Other CLI operations remain hidden, and no authentication output enters the renderer.

An earlier build could remain at **Signing in** because Electron's child process
had no usable console, even when merely disabling window hiding. The same CLI command
worked from a terminal. The repaired build creates a dedicated console and verifies
the resulting company identity before enabling publication.

Preserve unsent drafts and fully reopen Task Continuum to load this main-process
repair; do not reload the current VS Code conversation for a Dev Tunnel login error.
If an older window is stuck, cancel its login before signing in through the official
CLI with `devtunnel user login --entra --use-browser-auth`. Then choose **Refresh Dev
Tunnel status**. A verified external sign-in clears a stale login failure in the
repaired build; an unrelated publication error is not hidden. Do not repeatedly
start competing logins or reset device keys to solve a sign-in problem.

## Existing SSH Alias (Optional)

Select **SSH alias** on both the client and owner dialogs to retain the earlier
mode. A needs system OpenSSH and an existing host alias. B needs an independently
configured, reachable SSH server with approved public-key authentication, verified
host keys, and forwarding to the Bridge's current loopback port. This can also use
a separately managed Dev Tunnel. Task Continuum does not manage that external setup.
In this mode only, B's desktop may close after granting while its separate SSH
server and VS Code remain running. Do not expose the companion's HTTP port publicly.

An illustrative, independently provisioned client configuration is:

```sshconfig
Host copilot-b
  HostName CPC-lianc-L5CN7
  User approved-ssh-account
  IdentityFile C:/Users/your-user/.ssh/approved-key
  IdentitiesOnly yes
  BatchMode yes
  StrictHostKeyChecking yes
```

Replace the account and key path with approved values. Obtain the host fingerprint
through a trusted channel; do not disable verification to make Connect succeed.
Use a dedicated forwarding-only account where possible. The SSH account's OS
permissions are separate from an invitation: a full shell or privileged account
can access resources outside this application's scoped HTTP authorization.

## Legacy Session Invitations

1. On **A**, open a real AgentDesk task workspace in Task Continuum. Click the
  activity-bar icon **Remote VS Code sessions**, keep **Dev Tunnel + SSH** selected,
  sign in with Microsoft, then **Export client identity**.
   Send that public identity file to B through an approved channel. It contains a
  profile UUID, OS username, client machine name, and public SSH key, not a private key.
2. On **B**, link the original VS Code conversation to its task through **Sessions**
   and **Link to current task**, then **Connect VS Code**. This is the original
   workspace window, which can differ from the task repository. After upgrading,
   finish active work and use **Developer: Reload Window** before reconnecting.
3. On B's linked chat panel, click **Share original conversation remotely**. Keep
  **Dev Tunnel + SSH** selected, sign in, and choose **Publish this machine**.
  Review the native publication consent. Hosting displays the private tunnel ID
  and SSH host fingerprint. No conversation is shared by publication alone.
4. Choose **Read only** or **Read and send**, then **Choose recipient**. Select A's
   identity, choose an invitation destination outside every Git repository, and
   review the native authorization dialog. Verify the recipient's identity first.
5. Transfer the **private invitation** securely to A. Choose **Import invitation**
  without entering an alias or port. Compare the host fingerprint with B through
  a trusted channel and approve the exact owner, conversation, role, and expiry.
  Import does not connect or change a task link.
6. Click the connection's **Connect** icon. The app opens Dev Tunnel and pinned SSH
   and verifies B's bridge instance, original session/workspace, execution machine,
   and grant. Then choose **Link to T-XXXX** to associate the selected task. An
   existing different task association must be detached explicitly first.
7. Use the **REMOTE VS CODE** chat panel. Messages show the approved participant's
   username/client machine; replies show `Agent name @ execution machine`.
   **Connect SSH** reconnects that original owner, never a substitute local Agent.

C follows the same process with its own exported identity and private invitation.
Do not reuse A's invitation in C's desktop profile. A task repository can be cloned
or opened separately on A and C; identical task IDs in other local roots do not
share private enrollments.

For a legacy invitation, select **SSH alias**, export without a managed key if
needed, and enter A's already configured alias before import. Do not change an
invitation's transport or copy another desktop's private key to make it connect.

## Sending and Disconnecting

- The original Agent must be idle with no draft or unconfirmed earlier delivery.
  Read-only grants cannot send. Native tool approvals, agent questions, and response
  cancellation remain on B in this increment.
- B's existing `taskcontinuum.confirmOriginalSessionSend` setting applies to remote
  messages too. Its default is `true`; `false` skips only the extra delivery popup,
  not Copilot tool approvals or connection/invitation consent. The upgrade preserves
  this user's existing preference.
- Responses come from saved VS Code history, which can lag the UI by about a minute.
  The view refreshes every two seconds. It is not a guaranteed token stream.
- **Disconnect**, desktop shutdown, or cancelling a connection closes only the
  app-owned client transport. It does not stop B's executing Agent. Legacy enrollment
  restart restores cached history read-only; an explicitly connected legacy managed
  invitation can retry reads after transient network loss during the same run.
- **Forget** removes the selected private enrollment and cached history after
  confirmation. It does not revoke B's grant or delete the repository task link.
- B can revoke each invitation in its original chat's remote-access dialog.
  Authorization is rechecked before accepting dispatch and returning remote history.
  Managed revocation also removes its SSH grant and closes its connections.
  Revocation aborts unconfirmed delivery waits, but cannot undo a prompt already
  accepted by VS Code or erase history already received by another client.

Legacy session invitations expire after 24 hours or when B's bridge stops/reloads. After a bridge
restart, create and import a new invitation; a changed instance is never silently
trusted. A matching re-import replaces only that target's private enrollment.
Keep a failed or uncertain message's outcome under review; there is no offline
outbox. An explicit unchanged-text retry within the same panel uses the same UUID.
No automatic send retry or ownership takeover occurs when B is unreachable.

## Publication Lifecycle and Recovery

**Publish this machine** creates or reuses a private tunnel configured with
`--expiration 30d`; service expiry rules apply independently of 24-hour conversation
grants. The app remembers the resource, a stable SSH port, and explicit publication
intent. Enabled publication resumes on desktop launch; older records without an
enabled flag remain opt-in. Only the app's single SSH port may exist on this resource.

**Stop publication** closes the cloud host and app SSH listener after native
confirmation. Closing B's desktop has the same transport effect, without stopping
VS Code or its Agent. Device grants are restored from encrypted pairing policies.
Legacy SSH grants remain memory-only: explicit stop or desktop restart requires new
legacy invitations, while transient cloud reconnection preserves the live SSH host.

**Cancel Dev Tunnel operation** cancels pending browser login or publication setup;
it does not stop an already running publication. Each pending remote connection has
its own cancel control. Setup and CLI calls have bounded deadlines and errors do not
contain cloud access tokens. No indefinitely running terminal is required.

For an expired/deleted tunnel, a changed account, or an unavailable saved port,
use **Reset saved publication** in B's access dialog. Confirm the disconnection,
then sign in as the intended owner, publish again, and issue new invitations. Reset
removes only the local publication record; it preserves device keys and the original
Agent. The previous cloud resource remains owner-managed until its configured expiry.
No unknown process is killed and no port, account, or firewall policy is changed.

Wrong client key or lost profile: export this desktop's own identity and ask B to
enroll it again. Unavailable secure storage or a corrupt key fails closed rather
than saving plaintext or silently replacing identity. Unsupported sharing policy,
network denial, expired grant, busy Agent, or changed Bridge instance must be resolved
explicitly; none triggers an alternate Agent or weaker SSH verification.

## Storage and Trust

The task repository stores only `provider: vscode-copilot`, `sessionId`,
`workspaceStorageId`, and an optional `remoteMachineName`. Hostnames are metadata,
not authentication. Local bindings without the machine field keep their behavior.
The same remote target cannot be silently moved to a different task.

Private desktop profile files are `remote-vscode-identity.json`,
`remote-vscode-enrollments.json`, and `remote-vscode-cache/`. They contain the client
UUID, invitations/transport routes, and bounded saved views respectively. Credentials
never enter renderer state or task metadata. Keep these files and exported private
invitations outside version control and unapproved cloud sharing. A grant is a bearer
credential; managed transport additionally requires its bound device key and cloud
owner access. Participant names are owner-approved labels, not hardware attestation.
Owners can grant up to 32 active invitations per bridge.

Managed mode adds `dev-tunnel-client-identity.json`, `dev-tunnel-host-identity.json`,
and `dev-tunnel-publication.json` to the private profile. The first two contain public
keys and OS-encrypted private keys; the third contains the tunnel ID, SSH port, and
cloud owner identity. Private keys never leave their originating profile. Electron
secure storage is required, with no plaintext fallback. Official CLI account storage
remains CLI-owned; narrowly scoped cloud tokens are used only in main-process memory.

Legacy remote credentials can only handshake, read the single approved conversation, and
submit if granted write access. They cannot list other sessions, administer grants,
control unrelated windows, forward approvals, or run arbitrary commands through the bridge.
Read/write grants additionally permit the explicitly confirmed exact-session open operation.
Native source histories remain on B. New clients without a successful read have no
offline history; Git does not carry transcripts or access authority.

## Verification and Limits

Automated checks cover public identity/private invitation flow, wrong client and
workspace rejection, role enforcement, revocation during request processing,
strict real OpenSSH forwarding, cancellation, same-command deduplication, original
task links, restart cache, desktop IPC, and desktop/420px layouts. Separate ordinary
VS Code installation tests verify a remote request and saved deterministic reply
in the same native session without changing the other chat, tabs, or panel layout.
The companion bundles no CLI SDK, Dev Tunnels SDK, or ssh2 runtime; packaging rejects
unexpected externals. These transport dependencies run in the Electron main process.

On 2026-09-08, `npm run check` passed 215 tests across 41 files, plus lint, types,
and the production build. The complete desktop batch passed 23 scenarios with two
hosted-model opt-ins skipped. A live managed scenario used two real Electron desktops,
OS-protected device keys, and the actual private Microsoft Dev Tunnel service to carry
a synthetic original-session Bridge. It covered publication, enrollment, sending,
source identity, restart cache, explicit reconnect, revocation, stop, and desktop/420px
layouts. Its private cloud resource and temporary profiles were removed afterward.

To repeat only the real transport checks after signing in with the CLI and building:

```powershell
$env:TASKCONTINUUM_LIVE_DEV_TUNNEL = '1'
npm test -- test/dev-tunnel-manager.test.ts
npx playwright test e2e/remote-vscode.spec.ts
Remove-Item Env:TASKCONTINUUM_LIVE_DEV_TUNNEL
```

These tests use isolated profiles and temporary SSH keys on one Windows machine.
The additional opt-in `TASKCONTINUUM_VERIFY_DEV_TUNNEL_LOGIN=1`, together with
`TASKCONTINUUM_LIVE_DEV_TUNNEL=1`, verifies the actual sign-in button before the
managed desktop scenario. It can request interactive account verification and is
not enabled by ordinary tests. The repaired Windows flow passed that scenario,
including subsequent private publication, connect, revoke, and resource cleanup.
Login regressions plus the full suite passed 222 tests across 42 files using
`npm test -- --maxWorkers=2`; lint, strict types, and production build also passed.

The deterministic test participant is not shipped. They do not certify physical
A/B/C networking or an authenticated production Copilot reply in your environment.
The final manual check is A/C -> Dev Tunnel + SSH (or approved direct SSH) -> B's
signed-in original chat, with
matching native ID, usernames, execution machine, and a newly saved response.
Codex, Claude, remote tool decisions, automatic takeover, native forks, and managed
checkpoint synchronization are outside this remote VS Code increment.