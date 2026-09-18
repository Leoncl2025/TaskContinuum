# Owned task-document validation

Task Continuum owns the AgentDesk document contract copied from revision
`0cabc9faf70cc482de4fd94a31e0a281ec9a6e83`. The `.agentdesk` directory is a data
namespace, not a runtime dependency. See `THIRD_PARTY_NOTICES.md`.

## Headless commands

Install the product's locked dependencies with `npm ci`, then use Node 24:

```powershell
node Q:\src\Projects\TaskContinuum\scripts\task-documents.mjs validate --root .
node Q:\src\Projects\TaskContinuum\scripts\task-documents.mjs validate T-0009 --root .
node Q:\src\Projects\TaskContinuum\scripts\task-documents.mjs scan --all --root .
node Q:\src\Projects\TaskContinuum\scripts\task-documents.mjs check --root .
node Q:\src\Projects\TaskContinuum\scripts\task-documents.mjs reindex --root .
node Q:\src\Projects\TaskContinuum\scripts\task-documents.mjs schema:gen --root .
node Q:\src\Projects\TaskContinuum\scripts\task-documents.mjs schema:gen --check --root .
node Q:\src\Projects\TaskContinuum\scripts\task-documents.mjs create --title "Implement sign-in" --root .
```

`--root` defaults to the caller's current directory, never the product directory.
The `.mjs` launcher uses Node's native TypeScript transformation and import-resolution
hooks limited to the product's source tree. This supports the remote schemas'
extensionless imports and parameter properties. Neither a build nor `tsx` is required.
`npm run task-documents -- <command> --root <directory>` is also supported.

- `validate`: config, complete task schemas, lifecycle front matter, checklist
  duplicates, milestone/link references, job protocol, whole-workspace graph,
  and optional public remote-configuration consistency checks described below.
  Archived tasks participate in graph checks. A task filter retains global
  diagnostics and related graph issues; an unknown task is an error.
- `scan --all`: scans config, jobs, configured templates, all active/archived
  task Markdown, JSON and text, including broken task directories and `ref`
  material, plus Markdown, JSON and text beneath `.taskcontinuum`. It reports
  injection/credential findings with masked excerpts and one-based line numbers.
  Unreadable/unsafe scan paths fail closed. Staged-git scanning is not supported.
- `check`: document validation, public remote-record consistency and scanning.
- `reindex`: explicitly writes only `.agentdesk/index.json`, using the owned
  index contract and graph. Invalid tasks remain in `broken`; validation errors
  still produce a nonzero exit status. Never advances cursors or changes tasks.
- `schema:gen`: writes four deterministic files in `.agentdesk/schema`.
  `--check` is read-only and fails on drift or missing files; CRLF/LF is accepted.
- `create`: creates one complete canonical task directory using the same
  exclusive creation gate as the UI. It never updates another task or invokes Git.

Errors produce exit status 1; warnings and informational issues do not.
No command invokes Git, AgentDesk, a server, Electron, or a sibling checkout.

## Task creation

In the desktop app, **Create with agent** opens a local native Agent Host
conversation in the central chat pane, not a popup, even when the selected
workspace has no tasks. The first message includes these CLI instructions;
choose a model and send your requirements
directly, without copying a prompt to another application. Reopening verifies
the same privately recorded local session with its original Host before resuming
it. Use **Refresh created tasks** after
the agent finishes writing files. A running compatible Host and signed-in Copilot
provider are required; native tool approvals remain on that Host.

If the Host explicitly reports that the original session was deleted, choose
**Create local agent session** to start a new conversation. **Reconnect Agent
Host** and **Retry loading models** also check the original session while its
chat is open. Temporary connection failures or an unverified missing session
never trigger replacement or message replay.

Only a title is required. Optional arguments are `--description`, `--parent`,
`--owner`, `--level`, `--type`, `--priority`, `--slug`, repeatable `--acceptance`
and `--actor`. The configured workspace supplies valid owners and hierarchy.
Task IDs are allocated by the creator, not supplied by the caller.

From the Task Continuum source checkout:

```powershell
npm run task-documents -- create --root "Q:\Tasks\my-workspace" --title "Implement sign-in" --description "Support the managed account flow" --acceptance "A managed user can sign in" --actor copilot
npm run task-documents -- create --root "Q:\Tasks\my-workspace" --draft ".agentdesk\cache\new-task-draft.json" --actor copilot
```

Draft files must be inside the selected workspace, bounded JSON objects, and
must not be combined with conflicting field overrides. A draft uses this shape:

```json
{
  "title": "Implement sign-in",
  "description": "Support the managed account flow",
  "parentId": null,
  "type": "feature",
  "priority": "P2",
  "acceptance": ["A managed user can sign in"]
}
```

Optional `owner`, `level` and `slug` are also accepted. Do not include `id`,
`status`, derived fields or arbitrary paths. The CLI returns JSON containing the
allocated `taskId` and `directory`; do not retry a successful operation blindly.
For UI review, choose **Review agent draft** in the task-creation chat panel and
paste the same object in the review dialog. Reviewing a draft does not create
any files until the user confirms **Create task**.

Creation writes `task.json`, `skill.md`, requirement/plan/checklist/reference
documents and design/reference directories. It respects existing and archived
IDs, configured parents and members, and uses a workspace-scoped exclusive lock.
A busy or stale lock is an explicit error, not permission to delete another
process's state. Existing task directories and parent documents are never
overwritten. No index, Git commit, push, enrollment or session action is implied.

## Runtime and compatibility

`src/shared/taskDocuments` contains the complete fixed definitions, isolated
with `zod/v3`; the rest of Task Continuum continues using Zod 4. JSON Schema
generation uses the compatible generator. Independent tests pin SHA-256 of all
four upstream schema outputs, including defaults and unknown-field behavior.
The existing definitions intentionally accept `schemaVersion` as a string in
several schemas; this port does not silently tighten that historical behavior.
Scheduling checks report unusable calendar dates and out-of-range date arithmetic
as task-scoped diagnostics without changing the frozen date/lag schemas or
preventing graph analysis of the remaining tasks.

`validateDocuments` is the reusable read-only gate returning workspace, graph
and structured issues. Workspace opening and refresh use it and expose
diagnostics in the snapshot and existing visible warnings. Full-contract
documents are parsed first, and their displayed progress comes from the live
graph rather than persisted progress or an older derived index. Legacy reduced TaskCon documents remain displayable
but receive explicit contract errors; IDs wider than four digits are never
truncated, silently migrated or hidden merely for the stricter fixed ID rule.
Malformed tasks remain explicitly reported, not converted into valid empty
tasks. `patchTaskFields` is the reusable field-update gate (not an IPC endpoint).
It requires the expected content hash, applies an explicit field allow-list,
validates a full workspace overlay, and rechecks the hash before replacing only
the owning `task.json`. Existing field order, unknown fields, history and EOL are
preserved; changes append history. Source cursors, identity and derived fields
cannot be patched. Future field-edit/acceptance endpoints must use this boundary.
The separate `createTaskDocuments` gate is shared by the restricted task-creation
IPC and CLI; it only publishes a complete new task directory, not arbitrary
field edits. Agent drafts use the same creation schema as the form.
Front matter uses the locked safe YAML engine in `@11ty/gray-matter`; JavaScript
front matter and YAML JavaScript tags are rejected without execution.
The parser's process-global content cache is disabled, so successive document
revisions are not retained after validation.

Both readers retain containment/realpath protection. The document loader has a
1 MiB/file, 16 MiB/validation, 1,000-task and 20,000-directory-entry budget.
Content reads are cached within one validation, scanning reuses that budget,
and filesystem errors become diagnostics rather than broad silent catches.
Output paths are checked too. Scanning refuses symbolic links rather than
following aliases or cycles. Validation never writes an index automatically.

## Public remote-configuration consistency

When present, `.taskcontinuum/workspace.json` must use the D-002 public descriptor
schema and `.taskcontinuum/records/v1` must contain canonical immutable records.
Workspaces without either artifact behave exactly as before.

The synchronous read-only checker reuses `remoteConfig/records.ts` to validate
record schema versions, canonical content hashes, bytes and entity paths.
It matches record workspace IDs against the descriptor, checks device
self-signatures, and verifies other signatures using matching public device
publications. Missing actor keys, missing/wrong causal parents, and invalid
invitation identity/route/revocation references produce explicit errors.
These checks do not read local enrollment, private keys or application data.
They never call the network, admit trust, select effective heads, authorize
bindings, resolve conflicting operations, or apply records. A self-consistent
public key is **not** proof of local trust. Runtime trust policy and full
`resolveRecords` processing remain separate.

Descriptor reads are limited to 4 KiB and records to 32 KiB each, with the
10,000-record contract limit and four-level record directory depth. The document
checker's stricter shared 16 MiB read/20,000-entry budgets still apply across
all document and remote metadata. Symbolic/hard-linked record files are rejected.
Invalid remote JSON is diagnosed without echoing its potentially secret contents;
the scanner also examines invalid record files and masks detected credentials.

The CLI remains synchronous with the same commands and exit conventions.
Relocated installations must now include the owned remote-record schema closure
as well as the task-document folders (copying `src` is sufficient), alongside
the launcher and installed dependencies. No sibling AgentDesk checkout is used.
The four stage-1 generated document schemas are unchanged.

The checker does not enroll machines, create keys, push Git, or interpret
external prose as instructions.
