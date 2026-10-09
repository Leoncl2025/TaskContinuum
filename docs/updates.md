# Desktop updates and release operations

## User contract

The only update source is the public **stable** GitHub Releases channel at
<https://github.com/Leoncl2025/TaskContinuum/releases>. There is no configurable
feed URL, prerelease channel, downgrade channel, or renderer-supplied installer
path. Eligible installations check about 30 seconds after startup and every six
hours, download newer stable installers in the background, and show **Restart to
update** when ready. Installation always requires the user's separate restart
action; quitting normally never installs an update. Disable automatic checking
and downloading in **Preferences > Application updates**, or check manually.
Update initialization and downloads do not block opening the workbench or
establishing Agent Host connections.

Only an intentionally signed Windows **NSIS installation** can install an update
inside the application. ZIP copies, development runs, unsupported platforms and
ordinary unsigned builds are manual-only. `app.isPackaged` is not evidence of an
installation or signing capability.

An eligible build has all of these packaging inputs:

* The unchanged application ID: `com.leoncl2025.taskcontinuum`.
* An installer-created file beside `TaskContinuum.exe`,
  `taskcontinuum-install.json`:
  `{"schemaVersion":1,"distribution":"nsis","appId":"com.leoncl2025.taskcontinuum"}`.
  The NSIS install macro creates it; uninstall removes it. It is **never** part
  of the shared application payload, `win-unpacked` or the ZIP.
* `resources/update-policy.json`:
  `{"schemaVersion":1,"publisherNames":["<exact certificate common name>"]}`.
  The packaging hook produces this only with `TASKCONTINUUM_SIGNED_RELEASE=1`,
  an exact `TASKCONTINUUM_UPDATE_PUBLISHER`, and enforced signing configuration.
  Unsigned builds remove stale policy files and stay manual-only.
* Builder-generated `resources/app-update.yml` naming GitHub owner
  `Leoncl2025`, repository `TaskContinuum`, and the same trusted `publisherName`.
  No release API token is included in the packaged configuration.

The ZIP may contain the signed resource policy when built in a signed release,
but never the installation marker; it remains a **manual ZIP distribution**.
Copying files is not an installation. Do not manufacture markers or policies to
enable updates on an unsigned or portable build.

### First upgrade from 0.1.1 and earlier

Those builds have no installed updater/marker contract. Download the first
supported signed NSIS installer manually, compare its SHA-256 with the published
`SHA256SUMS.txt`, and verify Windows reports a valid signature from the release's
documented publisher. Close the old application and install into the existing
installation directory. Do not uninstall merely to upgrade. For an older ZIP,
install the NSIS release manually or replace the **entire** ZIP extraction while
the app is closed; the latter remains manual-only.

The application ID, product identity and existing user-data location are
preserved. The installer keeps `deleteAppDataOnUninstall: false`. Tasks,
workspaces, Host identities, local profiles and credentials are not migrated to
a different data directory or bundled in release assets. Back up important data
before the initial bridge upgrade.

Restart/install is blocked while application work or file transfers are active, any composer has
unsent text/images, or a task-creation form is open, including hidden panes.
Send or explicitly clear unsent input and finish or close creation forms, then
retry the restart action once active work has finished. Sensitive image drafts
are not automatically persisted, and draft survival across arbitrary restarts
is not promised. Restart temporarily disconnects remote clients and releases the
owner's native subscriptions. Empty chats that have never received an explicit
message may be collected by the native Host after all subscribers leave; an
update never sends a warm-up prompt or recreates such a chat.
Download, checksum, signature, network or installer errors do not trigger an
automatic downgrade or replace the installed app with the manual ZIP. Failures
before shutdown leave the current application usable. If shutdown has already
stopped services, ordinary operations stay locked and a recovery dialog requires
restarting the current application or closing it; stopped services are not
silently reused and messages are not replayed.
The full installer is launched with NSIS's update/relaunch arguments only after
checksum and signature revalidation. Task Continuum waits for successful process
creation before quitting; asynchronous launch failures reach the recovery dialog.
Permission failures are reported rather than retried through an implicit
elevation or shell fallback. Use the signed installer manually if required.

## Local unsigned packaging (never publishes)

```powershell
npm ci
npm run dist:win
npm run test:packaged
node scripts/release.mjs manifest v0.1.1 dist
node scripts/release.mjs verify v0.1.1 dist
```

Use the actual package version instead of `0.1.1`. `dist:win` retains
`--publish never`: it does not create tags, upload files, create releases, or
publish to npm. Without signed-release opt-in, local packaging needs no
certificate secrets and emits **no** trusted update policy. Unsigned Windows
downloads can display an unknown-publisher warning; checksums alone do not make
an unsigned executable signed.

The manifest command validates `latest.yml`, checks the actual NSIS SHA-512 and
size, requires the versioned installer, ZIP and NSIS `.blockmap`, then writes
`SHA256SUMS.txt`. `verify` checks the exact manifest names and actual SHA-256
values. Metadata must reference exactly one full NSIS installer, matching the
client's validation contract. Malformed YAML, duplicate keys/aliases, unsafe paths, arbitrary resource
URLs, version mismatches, missing assets and ZIP-as-installer metadata are
rejected. Only these five files are release assets:

```text
TaskContinuum-<version>-win-x64-setup.exe
TaskContinuum-<version>-win-x64-setup.exe.blockmap
TaskContinuum-<version>-win-x64.zip
latest.yml
SHA256SUMS.txt
```

`SHA256SUMS.txt` lists the other four files, not itself. ZIP is checked by
SHA-256 separately and is never an entry in `latest.yml`; NSIS update metadata
must select the EXE. The sidecar name is the installer's name plus `.blockmap`;
it is retained for the standard release bundle, although the current client uses
full installer downloads rather than differential downloads. Do not rename
assets after generating metadata.

## One-time repository administrator setup

The workflow file **does not create or enforce GitHub environment protection
rules by itself**. Before enabling a production release, an administrator must:

1. Protect the default branch with required review/status checks, and protect
   release tags against unauthorized creation, movement or deletion. Release
   tags must refer to commits already on default-branch history.
2. Create the `release-signing` environment. Restrict deployments to the trusted
   default branch and configure required reviewers/prevent self-review as
   appropriate. Store `CSC_LINK` (the code-signing PFX, preferably base64 rather
   than a publicly reachable certificate URL) and `CSC_KEY_PASSWORD` **only as
   environment secrets**, not repository/organization secrets exposed to other
   workflows. Certificate material must never be committed.
3. Set the environment variable `TASKCONTINUUM_UPDATE_PUBLISHER` to the signing
   certificate's **exact common name**, with no whitespace normalization,
   wildcard, placeholder or made-up publisher. The certificate must be valid
   for Authenticode signing and trusted by Windows. A self-signed test
   certificate is not a production signing solution.
4. Create the `production-release` environment with **required reviewer
   approval**, prevent self-review and restrict deployment branches to the
   trusted default branch. Reviewers must check the draft's assets, signing
   evidence, checksums and intended tag before approving publication.
5. Confirm the repository's plan and visibility support the configured
   environment protection features. If required reviewers cannot be enforced,
   do **not** treat this workflow as an approval-gated production release or
   enable production publishing. Naming an environment is not protection.

The workflow token defaults to read-only. Only the draft and publish jobs receive
`contents: write`; build jobs receive neither release-write permission nor a
release API token. Signing secrets are step-scoped and available only after
trusted-ref validation and the signing environment gate. Ordinary pushes, pull
requests and tag pushes do not run this workflow. Do not add a
`pull_request_target` or automatic push trigger.

## Release procedure

1. Choose a new stable version (strict `MAJOR.MINOR.PATCH`; no prerelease or build
   suffix). Update both package manifests using the normal dependency tooling,
   including the lockfile's top-level and root-package versions. Review and
   merge the release code onto the default branch.
2. Create and push `v<version>` at that reviewed commit. In GitHub Actions, run
   **Signed Windows release** from the **default branch** and supply the tag
   input. Inputs are passed as environment values, never interpolated into shell
   code.
3. The validation job resolves the tag to an immutable commit, verifies it is an
   ancestor of the remote default branch, and compares all package/lock versions.
   Build checks out that exact commit, uses Node.js 24 and `npm ci`, then runs
   unit tests, type checks, lint, build and packaged tests.
4. The signed build entry point is `node scripts/release-build.mjs`, with
   `TASKCONTINUUM_SIGNED_RELEASE=1`, `TASKCONTINUUM_UPDATE_PUBLISHER`, `CSC_LINK`
   and `CSC_KEY_PASSWORD` supplied by the protected job. It sets
   `forceCodeSigning: true` and `win.signtoolOptions.publisherName`, and still
   passes `publish: 'never'`.
5. `release-verify-signatures.ps1` uses Windows `Get-AuthenticodeSignature` to
   require **Valid** signatures with the expected certificate common name on
   the NSIS EXE, unpacked app EXE and extracted ZIP app EXE. It also checks the
   resource policy, builder-generated provider/publisher and marker absence.
   Packaged tests run against both `win-unpacked` and the extracted ZIP using
   isolated profiles. They do not install or upgrade the user's real app.
6. The job validates metadata/checksums and uploads only the five release files
   as a workflow artifact. Build completion alone does **not** create a public
   release.
7. The draft job downloads that artifact, revalidates it, rechecks the remote
   tag's commit and creates a **draft** release. It uploads the exact asset set,
   downloads each uploaded asset again, and compares sizes and SHA-256 hashes
   byte-for-byte with the validated workflow artifact.
8. The separate `publish` job waits for the `production-release` environment.
   After approval it repeats bundle, remote-tag and uploaded-byte checks, refuses
   published/nonstable releases or changed asset sets, then publishes the draft
   as the latest stable release.

Existing published versions are never edited or replaced. Equal/older stable
versions cannot be made latest. If a draft upload fails, investigate and remove
only the incomplete **unpublished draft** before rerunning; the scripts refuse to
silently overwrite a preexisting draft. Never move an already released tag.
Release serialization prevents two workflow runs racing to publish, while tag
and asset rechecks detect changes during the review pause.

## Verification boundaries

Unit tests exercise hostile metadata, exact checksum manifests and packaging
policy contracts. Local unsigned builds and packaged smoke tests can validate
the manual-only path without certificate secrets. A real signed two-version
NSIS upgrade, valid production certificate trust, timestamping and protection
rule enforcement require the configured signing environments and a disposable
Windows test installation. **Those are not proven by unsigned local tests.**
Do not claim a signed end-to-end live upgrade was tested without actually running
that test with valid signing credentials. Test future installer upgrades only in
an explicitly isolated, disposable installation and profile, not the real app.
