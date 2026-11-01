import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { repository, validateChecksums, validatePublishedVersions, validateVersion, writeChecksums } from './release-lib.mjs'

const [command, tag, directory = 'dist', expectedCommit] = process.argv.slice(2)
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const version = validateVersion(tag, tag?.slice(1), tag?.slice(1), tag?.slice(1))

async function api(route, init = {}) {
  if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN is required for release operations')
  const response = await fetch(`https://api.github.com/repos/${repository}${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...init.headers,
    },
  })
  if (!response.ok) throw new Error(`GitHub release API failed (${response.status})`)
  return response
}

async function verifyRemoteTag() {
  if (!/^[a-f0-9]{40}$/.test(expectedCommit ?? '')) throw new Error('Expected release commit is required')
  let object = (await (await api(`/git/ref/tags/${tag}`)).json()).object
  for (let depth = 0; object.type === 'tag' && depth < 5; depth++) {
    object = (await (await api(`/git/tags/${object.sha}`)).json()).object
  }
  if (object.type !== 'commit' || object.sha !== expectedCommit) throw new Error('Remote release tag moved or does not match the validated commit')
}

async function verifyRemoteAssets(release, names) {
  if (!release.draft || release.prerelease || release.tag_name !== tag || release.target_commitish !== expectedCommit) {
    throw new Error('Release is not the expected stable draft; published versions are immutable')
  }
  const assets = await (await api(`/releases/${release.id}/assets?per_page=100`)).json()
  if (JSON.stringify(assets.map((a) => a.name).sort()) !== JSON.stringify([...names].sort())) {
    throw new Error('Uploaded release asset names do not match the validated bundle')
  }
  for (const name of names) {
    const remote = assets.find((a) => a.name === name)
    const local = await readFile(path.join(directory, name))
    const response = await api(`/releases/assets/${remote.id}`, { headers: { Accept: 'application/octet-stream' } })
    const bytes = Buffer.from(await response.arrayBuffer())
    if (remote.size !== local.length || bytes.length !== local.length ||
        createHash('sha256').update(bytes).digest('hex') !== createHash('sha256').update(local).digest('hex')) {
      throw new Error(`Uploaded bytes/checksum mismatch: ${name}`)
    }
  }
}

async function publishedVersions() {
  const all = []
  for (let page = 1; ; page++) {
    const releases = await (await api(`/releases?per_page=100&page=${page}`)).json()
    all.push(...releases)
    if (releases.length < 100) return all
  }
}

if (command === 'ref') {
  const branch = process.env.GITHUB_DEFAULT_BRANCH
  if (!branch || process.env.GITHUB_REPOSITORY !== repository ||
      process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || process.env.GITHUB_REF !== `refs/heads/${branch}`) {
    throw new Error('Release dispatch must run the trusted default-branch workflow in the canonical repository')
  }
  const commit = git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`)
  git('merge-base', '--is-ancestor', commit, `refs/remotes/origin/${branch}`)
  const manifest = JSON.parse(git('show', `${commit}:package.json`))
  const lock = JSON.parse(git('show', `${commit}:package-lock.json`))
  validateVersion(tag, manifest.version, lock.version, lock.packages?.['']?.version)
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `commit=${commit}\nversion=${version}\n`)
  console.log(`Validated ${tag} at ${commit}`)
} else if (command === 'manifest') {
  console.log((await writeChecksums(directory, version)).join('\n'))
} else if (command === 'verify') {
  console.log((await validateChecksums(directory, version)).join('\n'))
} else if (command === 'draft' || command === 'publish') {
  await verifyRemoteTag()
  const names = await validateChecksums(directory, version)
  const releases = await publishedVersions()
  validatePublishedVersions(tag, releases)
  let release
  if (command === 'draft') {
    // Include drafts in this check. Never replace assets on an existing version.
    if (releases.some((candidate) => candidate.tag_name === tag)) throw new Error('A release already exists for this tag; refusing to modify it')
    release = await (await api('/releases', {
      method: 'POST',
      body: JSON.stringify({
        tag_name: tag, target_commitish: expectedCommit, name: tag, draft: true, prerelease: false,
        body: 'Signed Windows x64 NSIS installer and manual ZIP. Verify SHA256SUMS.txt before installation. See docs/updates.md for update and migration requirements.',
      }),
    })).json()
    for (const name of names) {
      const response = await fetch(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, 'Content-Type': 'application/octet-stream' },
        body: await readFile(path.join(directory, name)),
      })
      if (!response.ok) throw new Error(`Release asset upload failed (${response.status}): ${name}`)
    }
    release = await (await api(`/releases/${release.id}`)).json()
    await verifyRemoteAssets(release, names)
    console.log(`Verified draft ${release.html_url}`)
  } else {
    release = await (await api(`/releases/tags/${tag}`)).json()
    await verifyRemoteAssets(release, names)
    await verifyRemoteTag()
    const published = await (await api(`/releases/${release.id}`, {
      method: 'PATCH', body: JSON.stringify({ draft: false, prerelease: false, make_latest: 'true' }),
    })).json()
    if (published.draft || published.prerelease) throw new Error('Release did not become public and stable')
    console.log(`Published ${published.html_url}`)
  }
} else {
  throw new Error('Usage: node scripts/release.mjs ref|manifest|verify|draft|publish vMAJOR.MINOR.PATCH [dist] [commit]')
}
