// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import {
  artifactNames, readMetadata, safeAssetName, validateBundle, validateChecksums,
  validatePublishedVersions, validateVersion, writeChecksums,
} from '../scripts/release-lib.mjs'

let directory: string
const version = '0.2.0'
const names = artifactNames(version)
const installer = Buffer.from('test-only installer bytes')
const zip = Buffer.from('test-only zip bytes')
const hash = (bytes: Buffer) => createHash('sha512').update(bytes).digest('base64')
const metadata = () => ({
  version,
  files: [{ url: names.installer, sha512: hash(installer), size: installer.length }],
  path: names.installer,
  sha512: hash(installer),
  releaseDate: '2026-09-19T00:00:00.000Z',
})

beforeEach(async () => {
  await mkdir('artifacts', { recursive: true })
  directory = await mkdtemp(path.resolve('artifacts', 'release-validation-'))
  await Promise.all([
    writeFile(path.join(directory, names.installer), installer),
    writeFile(path.join(directory, names.zip), zip),
    writeFile(path.join(directory, `${names.installer}.blockmap`), 'test-only blockmap'),
    writeFile(path.join(directory, 'latest.yml'), stringify(metadata())),
  ])
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('release version and asset boundaries', () => {
  it('requires stable vSemver and matching package/lock versions', () => {
    expect(validateVersion('v0.2.0', '0.2.0', '0.2.0', '0.2.0')).toBe('0.2.0')
    for (const tag of ['0.2.0', 'v01.2.0', 'v0.2.0-beta.1', 'v0.2.0+build', 'v0.2.0;echo unsafe', 'v0.2.0\n']) {
      expect(() => validateVersion(tag, '0.2.0', '0.2.0', '0.2.0')).toThrow()
    }
    expect(() => validateVersion('v0.2.0', '0.2.1', '0.2.0', '0.2.0')).toThrow(/match/)
    expect(() => validateVersion('v0.2.0', '0.2.0', '0.2.1', '0.2.0')).toThrow(/match/)
    expect(() => validateVersion('v0.2.0', '0.2.0', '0.2.0', undefined)).toThrow(/match/)
    expect(() => validateVersion('v0.2.0\n', '0.2.0\n', '0.2.0\n', '0.2.0\n')).toThrow(/stable/)
  })

  it.each(['../outside.exe', '..\\outside.exe', 'C:\\outside.exe', '/outside.exe', 'https://other/asset.exe', '%2e%2e.exe', 'file.exe:stream', 'file.exe?query', 'file.exe#hash', 'file\n.exe', 'file.exe\n', '..', null])('rejects unsafe metadata paths: %s', (name) => {
    expect(() => safeAssetName(name)).toThrow()
  })

  it('does not publish equal or older stable releases as latest', () => {
    const releases = [{ tag_name: 'v0.2.0', draft: false, prerelease: false }]
    expect(() => validatePublishedVersions('v0.2.1', releases)).not.toThrow()
    expect(() => validatePublishedVersions('v0.2.0', releases)).toThrow(/newer/)
    expect(() => validatePublishedVersions('v0.1.9', releases)).toThrow(/newer/)
    expect(() => validatePublishedVersions('v0.1.9', [{ ...releases[0], draft: true }])).not.toThrow()
  })
})

describe('release metadata and actual asset integrity', () => {
  it('checks SHA512 and size, and manifests exactly installer, ZIP, metadata and sidecar', async () => {
    const files = await writeChecksums(directory, version)
    expect(files.sort()).toEqual([names.installer, names.zip, `${names.installer}.blockmap`, 'latest.yml', 'SHA256SUMS.txt'].sort())
    expect(await validateChecksums(directory, version)).toHaveLength(5)
  })

  it.each(['version: [', 'version: 0.2.0\nversion: 0.2.1', '[]', 'null', 'version: &v 0.2.0\npath: *v'])('rejects malformed/ambiguous YAML: %s', (text) => {
    expect(() => readMetadata(text)).toThrow()
  })

  it.each([names.installer, names.zip, `${names.installer}.blockmap`, 'latest.yml'])('rejects missing release resource %s', async (file) => {
    await rm(path.join(directory, file))
    await expect(validateBundle(directory, version)).rejects.toThrow()
  })

  it.each(['version', 'size', 'sha512', 'legacyHash', 'path', 'traversal', 'duplicate', 'zipReference', 'missingFiles', 'foreignReference'])('rejects invalid metadata: %s', async (failure) => {
    const value = metadata()
    switch (failure) {
      case 'version': value.version = '0.3.0'; break
      case 'size': value.files[0].size++; break
      case 'sha512': value.files[0].sha512 = hash(zip); break
      case 'legacyHash': value.sha512 = hash(zip); break
      case 'path': value.path = names.zip; break
      case 'traversal': value.files[0].url = '../outside.exe'; break
      case 'duplicate': value.files.push(value.files[0]); break
      case 'zipReference': value.files.push({ url: names.zip, sha512: hash(zip), size: zip.length }); break
      case 'missingFiles': value.files = []; break
      case 'foreignReference': Object.assign(value.files[0], { blockMap: '../other.blockmap' }); break
    }
    await writeFile(path.join(directory, 'latest.yml'), stringify(value))
    await expect(validateBundle(directory, version)).rejects.toThrow()
  })

  it('rejects an altered artifact despite intact metadata and manifest', async () => {
    await writeChecksums(directory, version)
    await writeFile(path.join(directory, names.installer), Buffer.alloc(installer.length))
    await expect(validateChecksums(directory, version)).rejects.toThrow(/SHA512/)
  })

  it('detects altered ZIP and blockmap through SHA256 even though only EXE is an update', async () => {
    await writeChecksums(directory, version)
    await writeFile(path.join(directory, names.zip), 'changed zip')
    await expect(validateChecksums(directory, version)).rejects.toThrow(/manifest/)
    await writeFile(path.join(directory, names.zip), zip)
    await writeFile(path.join(directory, `${names.installer}.blockmap`), 'changed sidecar')
    await expect(validateChecksums(directory, version)).rejects.toThrow(/manifest/)
  })

  it('rejects extra, duplicated, omitted or traversing checksum names', async () => {
    await writeChecksums(directory, version)
    const file = path.join(directory, 'SHA256SUMS.txt')
    const valid = await readFile(file, 'utf8')
    for (const invalid of [valid + valid, valid.split('\n').slice(1).join('\n'), valid + `${'0'.repeat(64)}  extra.txt\n`, valid.replace(names.zip, '../outside.zip')]) {
      await writeFile(file, invalid)
      await expect(validateChecksums(directory, version)).rejects.toThrow(/manifest/)
    }
  })
})
