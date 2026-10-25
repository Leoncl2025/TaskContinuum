# One-time, coordinated trust migration

This is an **operator-approved, in-place migration**, not a desktop startup
repair. It retains the workspace ID, device IDs, local key files, task data,
machine aliases, session bindings and owner-confirmation receipts. Old-format
reading exists only in the standalone migration tool; the desktop still rejects
expiring and null-expiry public invitations.

Do not run the mutation commands before approving the exact code commit, plan
hash, migration ID, participants, permission changes, shutdown and backups.
`inspect` and `plan` do not change the original profile or task checkout.
Successful compilation, installation or offline verification is not successful
end-to-end migration.

## Supported execution environment

The first operator CLI supports **Windows**, Node.js 24, Git, and the Electron
version in the repository lockfile. It uses Windows process inspection and
owner/SYSTEM-only backup ACLs. Other platforms stop rather than bypass these
checks. An unsupported or inaccessible device is not automatically safe to
exclude.

Build from the same **approved, clean, full commit SHA** on every participating
machine, in a code worktree separate from the running desktop. Keep the lockfile
and dependency versions unchanged:

```powershell
npm ci
npm run build
npm run migrate:trust -- --help
```

The CLI embeds its source commit and refuses inspection or migration when built
from an uncommitted worktree. Do not use a different branch tip or `latest`.
The script launches the migration entry with the worktree's Electron executable;
it does not launch the desktop. A small bootstrap isolates Electron before
loading the migration bundle, including help and module-load failures, and
removes its own temporary launch directory after exit. Do not invoke the raw
bundle or substitute the installed desktop EXE for this script.

Keep the worktree's lockfile-installed dependencies alongside the build. The
migration bundle loads `ssh2` at runtime, just as the desktop does, rather than
bundling its optional native modules as JavaScript. Copying only the bundle is
not a supported deployment. Do not delete native modules or disable installation
scripts to work around a build failure.

The migration helper requires its own absolute `--helper-data` directory. It must
not be the real TC profile or a directory inside the task workspace. The helper
does not create windows, discover or create sessions, send prompts, approve tools,
terminate TC, sign in to Dev Tunnels, or start the desktop after migration.

## Roles and inputs

- Exactly one machine is explicitly designated `COORDINATOR` by the operator.
  There is no election or default coordinator.
- Every `HOST` inspects and signs on its actual owner machine. Private keys,
  device tokens, encrypted private profiles and checkpoint directories are never
  collected by the coordinator.
- Public inspection reports, the plan, prepared public bundles and the public
  cutover receipt can be exchanged through an approved channel. They contain
  public keys, public operation commitments and derived policy summaries, not
  private credentials. Do not publish them automatically.
- The code repository and task-data Git repository are different inputs. The
  selected task workspace may be below the Git root. The tool uses the actual
  tracked upstream, never an assumed `main` branch.

Resolve all paths on each machine. The following variable names are placeholders,
not suggested machine-specific paths:

```powershell
$Workspace = '<absolute existing task workspace>'
$Profile = '<absolute existing TC private profile>'
$Helper = '<absolute separate migration-helper directory>'
$Report = '<absolute public inspection output file>'
$Plan = '<absolute approved plan file>'
$Checkpoint = '<absolute private checkpoint directory>'
$PublicBundle = '<absolute prepared public bundle output file>'
$Receipt = '<absolute public cutover receipt file>'
$PlanHash = '<approved 64-character plan SHA-256>'
```

Reports, helper data and checkpoints must be outside every Git repository.
The checkpoint must also be outside the profile, on the **same volume as the
profile**. Its parent must already exist.
It contains sensitive local backups; do not place it in Git, upload it, or use
another machine's checkpoint.

On Windows, the helper initializes newly created private directories with a
protected ACL granting access only to the current user and SYSTEM, including
when launched by an administrator. Existing directories are validated without
rewriting their ACLs; unrelated access or unprotected inheritance stops the tool.

## 1. Signed, read-only inspection on each device

```powershell
npm run migrate:trust -- inspect `
  --workspace $Workspace --profile $Profile --helper-data $Helper --out $Report
```

Inspection:

- Verifies original operation hashes, Ed25519 signatures, issuer/recipient
  identity references, causal dependencies, revocations and entity conflicts.
- Applies the original maximum 24-hour legacy grant policy. Expired grants are
  not silently promoted. Null-expiry, malformed or invalid old records abort.
- Checks public Git blobs against local files, accepted IDs, cached records,
  outbox, retained Git publications, upstream identity and rollback anchors.
- Requires a clean, fully published source checkout. Unknown, missing,
  conflicting or unpublished operations block migration; they are never dropped.
- Unlocks the existing client and host key files locally and compares their
  public identities with the enrollment pins. It never generates a replacement.
- Reads encrypted private pairing policies locally, retaining disabled routes,
  read-only scopes and paused enrollment/settings as authorization boundaries.
- Checks the actual bound task IDs and the exact locally owned
  `(taskId, owner.clientId, sessionId, chatId)` receipts.
- Signs a public inspection report. It does not rewrite the original profile,
  acquire or recover its store lock, or make a grant.

The report is a dry-run input, not an authorization allowlist. Repeated machine
names and aliases are not device identity: independently confirm each device ID
and its key fingerprints.

All participating reports must describe the same source commit, code commit,
workspace ID, public history and effective bindings. Assemble the plan within
one hour of report capture. Preparation rechecks the same data; a changed or
newly expired relationship requires another reviewed inspection/plan.

## 2. Explicit decisions and a single plan

The coordinator supplies a decisions JSON document. There is deliberately no
"convert all historical pairs" default:

```json
{
  "migrationId": "50000000-0000-4000-8000-000000000001",
  "coordinatorId": "00000000-0000-4000-8000-000000000001",
  "grants": [
    {
      "issuerId": "00000000-0000-4000-8000-000000000001",
      "recipientId": "00000000-0000-4000-8000-000000000002",
      "canSend": false
    }
  ],
  "fenced": []
}
```

Use newly assigned migration and real verified device IDs, not these examples.
An X-issued grant to Y permits **Y -> X**. `canSend: false` retains read-only
session/file access; it is not an invitation expiry.

Each known device requires either its own signed report or an explicit fencing
decision:

```json
{
  "deviceId": "00000000-0000-4000-8000-000000000003",
  "evidenceHash": "<SHA-256 of the operator-reviewed fencing evidence>",
  "reason": "Specific verified retirement and publication-isolation decision"
}
```

The evidence must establish how the old installation is prevented from publishing
or reconnecting into the cutover domain. A hash, an offline indicator or a stale
hostname is **not** proof by itself. The operator must review the evidence before
approval. Old Git writers with repository credentials can still append bad data;
the new runtime will reject that data, not silently repair the shared branch.

The tool compares directed grants with both sides' reported public/private
policy. Newly authorized relationships and read-to-send increases need a
specific `changeReason` on that grant and appear in the plan's `changes`.
Removing a currently allowed relationship requires a `removalReason`. Generic
change approval cannot reinstate a locally revoked or removed identity.

The migration checkpoint freezes automatic grants to the approved participants,
keys and directed relationship/permission set. Existing enrollment flags are
retained, but they cannot admit another device outside this checkpoint. Review
this boundary explicitly: later onboarding, key rotation or policy widening
requires a separate reviewed change, not another automatic old-history import.
Reports with automatic admission enabled add an explicit
`freeze-auto-admission` entry to the plan's change list.

```powershell
npm run migrate:trust -- plan `
  --reports '<coordinator report>' --reports '<host report>' `
  --decisions '<decisions JSON>' --helper-data $Helper --out $Plan
```

Review the complete plan, including all changes, retained/retired IDs, file
hashes and effective binding hash. Approve its full code SHA, UUID `migrationId`
and printed `planHash` together. The supplied `--approve` value on mutation
commands is an explicit acknowledgement of that exact approved plan; it is not
a signature made on behalf of another device.

## 3. Stop, back up and prepare every participating host

After approval, stop each verified old TC instance and its synchronization/
publication. Use an external execution/recovery environment if TC hosts the
operator session. Never kill processes by name, and do not stop the current
session host without the agreed external recovery method.

Only then, on **each** participating machine:

```powershell
npm run migrate:trust -- prepare-host `
  --workspace $Workspace --profile $Profile --helper-data $Helper `
  --checkpoint $Checkpoint --report $Report --plan $Plan --approve $PlanHash `
  --out $PublicBundle
```

Preparation checks for active profile processes and source locks. It makes:

- An owner-protected full local profile backup.
- A byte-verified task-workspace backup and verified Git bundle.
- A private preparation checkpoint, recording source hashes and original anchors.
- A durable migration gate and an unsupported pending runtime marker. Neither
  the old desktop nor the new desktop may run that prepared workspace.
- This device's deterministic new public grants, signed with its existing local
  client key, and its signed approval/prepared bundle.

It does **not** clear the old cache, outbox, accepted IDs, keys, receipts or
policies. A recognized exited store owner's lock is retained with the old state;
a live, unreadable or foreign lock stops preparation. Nothing removes an old lock
merely to make startup succeed.

Send only the public bundle, never `$Checkpoint`, to the coordinator.
No shared cutover can be published until every participating device provides a
valid bundle for the same plan. Keep all prepared desktops stopped.

## 4. Coordinator-only shared Git cutover

```powershell
npm run migrate:trust -- publish-cutover `
  --workspace $Workspace --profile $Profile --helper-data $Helper `
  --checkpoint $Checkpoint --plan $Plan --approve $PlanHash `
  --bundles '<coordinator public bundle>' --bundles '<host public bundle>' `
  --out $Receipt
```

This builds and publishes **two distinct, ordinary descendant commits**:

1. **Baseline commit:** retires the invitation records from the active tree,
   retains every non-invitation blob unchanged, preserves the workspace ID, and
   installs the plan-hash-bound schema-v2 workspace descriptor.
2. **Authorization commit:** appends only the actual devices' prepared, signed
   `until-revoked` grants.

Original history remains in Git ancestry and protected backups. There is no
force push, history rewrite, merge into a code `main` branch or rewriting of an
old signature/expiry field. A changed upstream causes an explicit stop.

The coordinator does not silently update its local task checkout here. It adopts
the same receipt as every other host. Distribute the receipt and record the
baseline and authorization commit IDs separately.

## 5. Adopt the same baseline on a pilot, then the remaining hosts

Keep TC stopped during adoption:

```powershell
npm run migrate:trust -- adopt-host `
  --workspace $Workspace --profile $Profile --helper-data $Helper `
  --checkpoint $Checkpoint --receipt $Receipt --plan $Plan --approve $PlanHash
```

The tool independently verifies the exact baseline and authorization commits,
then checks any later append-only, signed records against the same baseline. It
never treats the current branch tip as a new migration baseline.

The local installation is journaled:

1. Safely advances the clean existing checkout, without resetting/stashing user
   changes or overwriting an incoming local/ignored file.
2. Stages new-format cache, outbox, retained publications and accepted IDs.
3. Archives the original synchronization directory, including its old store
   state and lock, under the protected checkpoint.
4. Atomically installs the staged state in the **original** synchronization path.
5. Records the immutable baseline anchor and advances the existing accepted
   anchors by compare-and-swap, retaining the original anchor evidence.
6. Verifies preserved public bytes, binding identities, original identity/key/
   policy/receipt file hashes and retired-record absence before releasing its gate.

Runtime metadata becomes schema v3, so an old desktop cannot reopen a migrated
profile even while offline. The desktop's public invitation reader still has
only the `until-revoked` format. Old cached or Git records fail closed.

Offline installation verification is also available:

```powershell
npm run migrate:trust -- verify-host `
  --workspace $Workspace --profile $Profile --helper-data $Helper `
  --checkpoint $Checkpoint --receipt $Receipt --plan $Plan --approve $PlanHash
```

This verifies the stopped installation against the preparation checkpoint.
It does not send authentication requests, restart the application or declare
`MIGRATED_VERIFIED`. After normal operation starts, legitimate private credential
renewal or user policy changes can alter private file hashes; do not rerun
installation steps to undo them.

## Interruption and recovery

Never delete locks, checkpoints, outboxes, accepted lists or rollback refs as a
repair. Never automatically fall back to an old-format desktop.

- **Before a preparation checkpoint exists:** originals are unchanged. A partial
  backup is not accepted as complete. Retain it; recheck the originals and use a
  new protected checkpoint location if the incomplete copy cannot be verified.
- **After preparation or a partial local installation:** keep TC stopped and
  rerun the same command with the same fixed code, original signed report, plan
  hash and private checkpoint. Recorded stages recognize already completed
  writes and refuse divergent bytes. Grants and Git commits do not multiply.
- **Publication result uncertain:** use the existing public cutover receipt.
  Retrying the coordinator publication confirms the same commit or stops if
  another writer changed the upstream. Do not force push.
- **Checkout was written but its branch ref was not advanced:** the journal
  accepts only the exact recorded target tree and advances the original branch
  by compare-and-swap. Any user edits stop recovery.
- **State directory archived but not installed:** the protected old state and
  stage remain available; the same adoption command installs the verified stage.
- **Wrong baseline, altered backup, new records, changed keys or permissions:**
  stop and report the mismatch. Do not reinterpret the existing approval as
  approval for another source or silently discard the difference.

The backups contain full original bytes and a Git bundle, plus the original
accepted-anchor list. If forward resumption is not possible, an operator may
authorize restoration into a separate, disconnected recovery location for
inspection. Do not publish a Git rollback or resume old TC against the cutover
branch. Rejoining requires another explicitly approved recovery plan. The tool
does not provide an automatic destructive restore command.

## Acceptance and test evidence

Before resuming beyond the pilot, verify on the real intended devices:

- Same workspace/device/key/alias identities, exact binding ownership and local
  owner receipts; unchanged revocation, pause, disabled-route and read/send
  boundaries.
- Same approved baseline commit everywhere, even after legitimate later
  authorization additions.
- No retired operations in the active public tree, caches, pending outboxes or
  retained publication set; originals still recoverable from protected backups.
- Actual authentication after approved restart and disconnect/reconnect.
- Stable public grant IDs and Git head after initial grants when identities,
  routes and policy are unchanged; private credential renewal need not create
  public history.
- Explicit handling of every fenced, unsupported or unavailable device.

The isolated tests use generated keys, fake existing session IDs/receipts and
local bare Git remotes. They cover cryptographic legacy verification, exact
preservation, read-only runtime restoration, simulated clock advancement,
interrupted preparation/publication/checkout/state installation, reentry, wrong
baselines, forged bundles, missing history, user edits, old writers and rollback
branches. They never contact real sessions, change the system clock, revoke a
business device or send an LLM message.
