import { createHash } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseDocument } from 'yaml'

export const repository = 'Leoncl2025/TaskContinuum'
export const appId = 'com.leoncl2025.taskcontinuum'
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$(?![\s\S])/
const filename = /^[A-Za-z0-9][A-Za-z0-9._-]*$(?![\s\S])/

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

export function validateVersion(tag, packageVersion, lockVersion, lockRootVersion) {
  requireValue(typeof tag === 'string' && tag.startsWith('v') && stableVersion.test(tag.slice(1)), 'Release tag must be stable vMAJOR.MINOR.PATCH')
  const version = tag.slice(1)
  requireValue([packageVersion, lockVersion, lockRootVersion].every((value) => value === version), 'Tag, package and lock versions must match')
  return version
}

export function safeAssetName(name) {
  requireValue(typeof name === 'string' && filename.test(name) && name !== '.' && name !== '..' && !name.includes('..'), 'Unsafe release asset path')
  return name
}

export function readMetadata(text) {
  const document = parseDocument(text, { uniqueKeys: true })
  requireValue(document.errors.length === 0, 'Invalid release YAML')
  const metadata = document.toJS({ maxAliasCount: 0 })
  requireValue(metadata && typeof metadata === 'object' && !Array.isArray(metadata), 'Invalid release metadata')
  return metadata
}

export function signedPolicy(env, config) {
  if (env.TASKCONTINUUM_SIGNED_RELEASE !== '1') return null
  const publisher = env.TASKCONTINUUM_UPDATE_PUBLISHER
  requireValue(typeof publisher === 'string' && publisher.length > 0 && publisher.trim() === publisher && !/[\r\n\0]/.test(publisher), 'Signed release requires an exact certificate common name')
  requireValue(config.forceCodeSigning === true && config.win?.signtoolOptions?.publisherName === publisher, 'Signed release must enforce code signing and the configured publisher')
  return { schemaVersion: 1, publisherNames: [publisher] }
}

export function validateUpdateConfig(config, publisher) {
  const allowed = new Set(['provider', 'owner', 'repo', 'releaseType', 'publisherName', 'updaterCacheDirName'])
  const publishers = Array.isArray(config.publisherName) ? config.publisherName : [config.publisherName]
  requireValue(Object.keys(config).every((key) => allowed.has(key)) &&
    config.provider === 'github' && config.owner === 'Leoncl2025' && config.repo === 'TaskContinuum' &&
    config.releaseType === 'release' && typeof publisher === 'string' && publisher.length > 0 &&
    publishers.length === 1 && publishers[0] === publisher,
  'Packaged updater provider/publisher configuration is not the fixed release policy')
}

async function asset(directory, name) {
  safeAssetName(name)
  const file = path.join(directory, name)
  const stat = await lstat(file)
  requireValue(stat.isFile() && !stat.isSymbolicLink(), `Asset must be a regular file: ${name}`)
  requireValue(stat.size > 0, `Empty release asset: ${name}`)
  return readFile(file)
}

export function artifactNames(version) {
  requireValue(stableVersion.test(version), 'Invalid stable version')
  return {
    installer: `TaskContinuum-${version}-win-x64-setup.exe`,
    zip: `TaskContinuum-${version}-win-x64.zip`,
  }
}

export function validatePublishedVersions(tag, releases) {
  const version = validateVersion(tag, tag.slice(1), tag.slice(1), tag.slice(1))
  for (const release of releases) {
    if (release.draft || release.prerelease || typeof release.tag_name !== 'string' ||
        !release.tag_name.startsWith('v') || !stableVersion.test(release.tag_name.slice(1))) continue
    const current = version.split('.').map(BigInt)
    const previous = release.tag_name.slice(1).split('.').map(BigInt)
    const difference = current.findIndex((part, index) => part !== previous[index])
    requireValue(difference !== -1 && current[difference] > previous[difference], 'Release version must be newer than every published stable version')
  }
}

export async function validateBundle(directory, version) {
  const names = artifactNames(version)
  const metadata = readMetadata((await asset(directory, 'latest.yml')).toString('utf8'))
  const metadataKeys = new Set(['version', 'files', 'path', 'sha512', 'size', 'releaseDate', 'releaseName', 'releaseNotes'])
  requireValue(Object.keys(metadata).every((key) => metadataKeys.has(key)), 'Unexpected release metadata field')
  requireValue(metadata.version === version, 'Metadata version mismatch')
  requireValue(Array.isArray(metadata.files) && metadata.files.length === 1, 'Metadata must contain exactly one full NSIS installer')
  requireValue(metadata.path === names.installer, 'Latest metadata must select the NSIS installer, not ZIP')
  const allowed = new Set([names.installer])
  const referenced = new Set()
  for (const entry of metadata.files) {
    requireValue(entry && typeof entry === 'object', 'Invalid metadata file entry')
    requireValue(Object.keys(entry).every((key) => ['url', 'sha512', 'size', 'blockMapSize', 'isAdminRightsRequired'].includes(key)), 'Unexpected metadata file field')
    const name = safeAssetName(entry.url)
    requireValue(allowed.has(name) && !referenced.has(name), 'Unexpected or duplicate metadata asset')
    const bytes = await asset(directory, name)
    requireValue(Number.isSafeInteger(entry.size) && entry.size === bytes.length, `Size mismatch: ${name}`)
    requireValue(typeof entry.sha512 === 'string' && entry.sha512 === createHash('sha512').update(bytes).digest('base64'), `SHA512 mismatch: ${name}`)
    if (name === names.installer) {
      requireValue(metadata.sha512 === entry.sha512, 'Legacy installer SHA512 mismatch')
      if (metadata.size !== undefined) requireValue(metadata.size === bytes.length, 'Legacy installer size mismatch')
    }
    referenced.add(name)
  }
  requireValue(referenced.has(names.installer), 'NSIS installer missing from metadata')
  requireValue(metadata.packages === undefined, 'Unexpected web-installer packages')
  // Builder produces this sidecar for NSIS differential updates; ZIP is a manual download.
  const blockmap = `${names.installer}.blockmap`
  await asset(directory, names.zip)
  await asset(directory, blockmap)
  const assets = [names.installer, names.zip, blockmap, 'latest.yml'].sort()
  return { version, assets }
}

export async function checksumsFor(directory, assets) {
  const sorted = [...assets].sort()
  requireValue(new Set(sorted).size === sorted.length, 'Duplicate checksum asset')
  const lines = await Promise.all(sorted.map(async (name) => `${createHash('sha256').update(await asset(directory, name)).digest('hex')}  ${name}`))
  return `${lines.join('\n')}\n`
}

export async function writeChecksums(directory, version) {
  const bundle = await validateBundle(directory, version)
  await writeFile(path.join(directory, 'SHA256SUMS.txt'), await checksumsFor(directory, bundle.assets))
  return [...bundle.assets, 'SHA256SUMS.txt']
}

export async function validateChecksums(directory, version) {
  const bundle = await validateBundle(directory, version)
  const actual = (await asset(directory, 'SHA256SUMS.txt')).toString('utf8')
  requireValue(actual === await checksumsFor(directory, bundle.assets), 'Checksum manifest must contain exactly the expected names and SHA256 values')
  return [...bundle.assets, 'SHA256SUMS.txt']
}
