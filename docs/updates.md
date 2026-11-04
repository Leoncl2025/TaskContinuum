# Desktop updates and release operations

## User contract

The only update source is the public **stable** GitHub Releases channel at
<https://github.com/Leoncl2025/TaskContinuum/releases>. There is no configurable
feed URL, prerelease channel, downgrade channel, or renderer-supplied installer
path. By default, eligible Windows installer builds check after the first window
has loaded (30 seconds), then every six hours, and automatically download a newer
stable update. Downloading never restarts or installs the application.
**Restart and update** is a single explicit action with no second confirmation
dialog; the restart safety checks still run before any installer is invoked.
Automatic checking/downloading can be disabled in **About and updates**, opened
from the titlebar. A manual check with automatic updates disabled only discovers
the release; **Download update** remains available.

The titlebar shows compact checking/download progress and a one-click restart
action when ready. A lightweight ready notice also offers **Later**; dismissing
it does not discard the verified download. The same notice is not repeated by
checks or workspace switches, while the titlebar restart action remains.
Update state is owned above workspace/session selection so notifications cannot
switch the selected task or recreate a chat.

Windows x64 **NSIS installations** can install updates inside the application,
including unsigned builds. A Windows code-signing certificate and an
`update-policy.json` file are not prerequisites. ZIP copies, development runs
and unsupported platforms remain manual-only. `app.isPackaged` is not evidence
of an installation.

The baseline trust model is the fixed public GitHub repository over HTTPS plus
strict release/version/asset metadata and SHA-512 verification. The checksum is
checked after downloading, including cache hits, and again immediately before
launching the installer. This protects package integrity; it is not an
independent publisher signature. Access to the repository's release-publishing
credentials is trusted. Windows may still show an unknown-publisher or other
system security prompt for an unsigned executable.

An eligible build has these packaging inputs:

* The unchanged application ID: `com.leoncl2025.taskcontinuum`.
* An installer-created file beside `TaskContinuum.exe`,
  `taskcontinuum-install.json`:
  `{"schemaVersion":1,"distribution":"nsis","appId":"com.leoncl2025.taskcontinuum"}`.
  The NSIS install macro creates it; uninstall removes it. It is **never** part
  of the shared application payload, `win-unpacked` or the ZIP.
* Builder-generated `resources/app-update.yml` naming GitHub owner
  `Leoncl2025` and repository `TaskContinuum`.
  No release API token is included in the packaged configuration.

Windows publisher signing is an optional additional requirement:

* If `resources/update-policy.json` is present, it must contain
  `{"schemaVersion":1,"publisherNames":["<exact certificate common name>"]}`.
  The packaging hook produces this only with `TASKCONTINUUM_SIGNED_RELEASE=1`,
  an exact `TASKCONTINUUM_UPDATE_PUBLISHER`, and enforced signing configuration.
  Such builds verify the installed executable and every downloaded/cached
  installer against that exact publisher, including immediately before launch.
  The generated update configuration must name the same trusted publisher.
  Missing, untrusted or unverifiable signatures fail closed in this mode.
* An absent policy uses the certificate-free baseline. A malformed or unreadable
  policy is an error, not permission to fall back. Unsigned packaging removes
  stale policies rather than inventing a publisher.

The ZIP may contain the signed resource policy when built in a signed release,
but never the installation marker; it remains a **manual ZIP distribution**.
Copying files is not an installation. Do not manufacture markers to turn a
portable copy into an installation, or invent a signed publisher policy.

### First upgrade from existing manual-only clients

Versions v0.2.0 and v0.2.1 hard-code the signed-policy prerequisite, and v0.1.1
and earlier have no installed updater/marker contract. Download the v0.2.2 or
later NSIS installer manually and compare
its SHA-256 with the published `SHA256SUMS.txt`. If the release is signed, also
verify its documented Windows publisher. Close the old application and install
into the existing installation directory. Do not uninstall merely to upgrade.
This one-time manual installation updates the client-side gate; publishing a
new asset alone cannot change an older installed client. For an older ZIP,
install the NSIS release manually or replace the **entire** ZIP extraction while
the app is closed; the latter remains manual-only.

The application ID, product identity and existing user-data location are
preserved. The installer keeps `deleteAppDataOnUninstall: false`. Tasks,
workspaces, Host identities, local profiles and credentials are not migrated to
a different data directory or bundled in release assets. Back up important data
before the initial bridge upgrade.

Restart/install is blocked while application work is active, any composer has
unsent text/images, or a task-creation form is open, including hidden panes.
Send or explicitly clear unsent input and finish or close creation forms, then
retry the restart action once active work has finished. Sensitive image drafts
are not automatically persisted, and draft survival across arbitrary restarts
is not promised.
Active file transfers, file previews/reads, local MCP file requests, queued
gateway requests and incoming device operations are included in restart safety.
New desktop/device work is rejected while restart preparation holds its barrier.
Download, checksum, signature, network or installer errors do not trigger an
automatic downgrade or replace the installed app with the manual ZIP. Failures
before shutdown leave the current application usable. If shutdown has already
stopped services, ordinary operations stay locked and a recovery dialog requires
restarting the current application or closing it; stopped services are not
silently reused and messages are not replayed.
The full installer is launched with NSIS's silent `/S` and update/relaunch arguments only after
checksum revalidation and any configured publisher revalidation. Task Continuum waits for successful process
creation before quitting; asynchronous launch failures reach the recovery dialog.
Permission failures are reported rather than retried through an implicit
elevation or shell fallback. Use the installer manually if required.

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
an unsigned executable signed. Once installed through NSIS, such builds can
download and install updates using the certificate-free baseline above.

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

### Historical manual-only v0.2.0 and v0.2.1 releases

The already published v0.2.0 and v0.2.1 binaries remain unchanged. Their old
signed-policy prerequisite still requires a manual upgrade to a corrected build.
This restriction does not apply to unsigned NSIS builds containing the change
described above. No published version's assets or tag are replaced.

An explicitly requested manual release is separate from the signed workflow
below. Build locally with `--publish never`, verify the five-file bundle, confirm
the application and installer are unsigned and the shared payload has neither
an installation marker nor a trusted update policy, and run isolated packaged
tests. Create a GitHub draft with the exact version tag and an unsigned-build
notice. Upload only the five validated assets, download them again and verify
their sizes and SHA-256 values before publishing. Do not use the signed release
script's default description or claim that a signed upgrade was tested.
Never replace the assets of an already published version.

Installing these releases preserves the existing application identity and
user-data location. Existing configuration formats must still satisfy the
[device-trust upgrade requirements](workspace-git-sync.md#durable-device-trust-one-format-breaking-change);
an installer upgrade does not migrate or authorize old signed history.

## Optional signed-workflow administrator setup

The optional signed workflow **does not create or enforce GitHub environment
protection rules by itself**. Before enabling that workflow, an administrator must:

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

## Signed workflow release procedure

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
policy contracts, certificate-free NSIS download/install wiring, configured
publisher enforcement, default background downloading, the exact 30-second startup
delay, one-click restart, ready-notice dismissal and active-work/draft vetoes.
Renderer fonts are emitted as packaged files, including small KaTeX fonts;
the existing `font-src 'self'` CSP is retained without a `data:` exception.
Local unsigned builds and packaged smoke tests validate portable-copy behavior
and certificate-free installed-build eligibility without certificate secrets.
A real signed two-version
NSIS upgrade, valid production certificate trust, timestamping and protection
rule enforcement require the configured signing environments and a disposable
Windows test installation. **Those are not proven by unsigned local tests.**
Do not claim a signed end-to-end live upgrade was tested without actually running
that test with valid signing credentials. Test future installer upgrades only in
an explicitly isolated, disposable installation and profile, not the real app.
