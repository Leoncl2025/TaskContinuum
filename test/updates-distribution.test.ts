// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { detectDistribution } from '../src/main/updates/distribution'
import { fileUpdatePreferences } from '../src/main/updates/preferences'
import { validateWindowsSignature } from '../src/main/updates/signature'

const marker = JSON.stringify({ schemaVersion: 1, distribution: 'nsis', appId: 'com.leoncl2025.taskcontinuum' })
const policy = JSON.stringify({ schemaVersion: 1, publisherNames: ['Task Continuum Publisher'] })
const missing = () => Object.assign(new Error('not found'), { code: 'ENOENT' })
function fixture(values: { marker?: string; policy?: string } = { marker, policy }) {
  const verifySignature = vi.fn(async () => {})
  const readText = vi.fn(async (path: string) => {
    const value = path.endsWith('taskcontinuum-install.json') ? values.marker : values.policy
    if (value === undefined) throw missing()
    return value
  })
  return { isPackaged: true, platform: 'win32', arch: 'x64', execPath: 'C:\\Apps\\TaskContinuum.exe', resourcesPath: 'C:\\Apps\\resources', readText, verifySignature }
}

describe('distribution capability', () => {
  it('requires marker, valid nonempty policy, and verified installed executable', async () => {
    const options = fixture()
    expect(await detectDistribution(options)).toEqual({ distribution: 'nsis', canInstall: true, publisherNames: ['Task Continuum Publisher'] })
    expect(options.verifySignature).toHaveBeenCalledWith(options.execPath, ['Task Continuum Publisher'])
  })
  it('never enables archives from policy alone', async () => {
    const options = fixture({ policy })
    expect(await detectDistribution(options)).toMatchObject({ distribution: 'archive', canInstall: false })
    expect(options.verifySignature).not.toHaveBeenCalled()
  })
  it('makes unsigned NSIS installations manual-only', async () => {
    expect(await detectDistribution(fixture({ marker }))).toMatchObject({ distribution: 'nsis', canInstall: false, reason: expect.stringContaining('no signed update policy') })
  })
  it.each(['{}', '{', JSON.stringify({ schemaVersion: 2, distribution: 'nsis', appId: 'com.leoncl2025.taskcontinuum' }), JSON.stringify({ schemaVersion: 1, distribution: 'nsis', appId: 'other' })])('rejects invalid marker %s', async value => {
    expect(await detectDistribution(fixture({ marker: value, policy }))).toMatchObject({ canInstall: false, reason: expect.stringContaining('Invalid installation marker') })
  })
  it.each(['{}', '{', JSON.stringify({ schemaVersion: 1, publisherNames: [] }), JSON.stringify({ schemaVersion: 1, publisherNames: [''] }), JSON.stringify({ schemaVersion: 1, publisherNames: [' '] }), JSON.stringify({ schemaVersion: 1, publisherNames: [42] }), JSON.stringify({ schemaVersion: 2, publisherNames: ['Publisher'] })])('rejects malformed policy %s', async value => {
    const options = fixture({ marker, policy: value })
    expect(await detectDistribution(options)).toMatchObject({ canInstall: false, reason: expect.stringContaining('Invalid signed update policy') })
    expect(options.verifySignature).not.toHaveBeenCalled()
  })
  it('fails closed on untrusted executable or unavailable verification', async () => {
    const options = fixture()
    options.verifySignature.mockRejectedValue(new Error('Signature invalid'))
    expect(await detectDistribution(options)).toMatchObject({ canInstall: false, reason: expect.stringContaining('Signature invalid') })
  })
  it.each([{ isPackaged: false, expected: 'development' }, { platform: 'linux', expected: 'unsupported' }, { arch: 'arm64', expected: 'unsupported' }])('gates unsupported runtime $expected', async override => {
    const options = { ...fixture(), ...override }
    expect(await detectDistribution(options)).toMatchObject({ canInstall: false, distribution: override.expected })
    expect(options.readText).not.toHaveBeenCalled()
  })
})

describe('fail-closed Authenticode validation', () => {
  const file = 'C:\\Apps\\TaskContinuum.exe'
  const valid = { Status: 0, Path: file, Subject: 'CN=Publisher, O=Company', Name: 'Publisher' }
  it('accepts only an exact trusted publisher and the requested path', () => {
    expect(() => validateWindowsSignature(file, ['Publisher'], JSON.stringify(valid))).not.toThrow()
    expect(() => validateWindowsSignature(file, ['CN=Publisher, O=Company'], JSON.stringify(valid))).not.toThrow()
  })
  it.each([{ Status: 1 }, { Status: 2 }, { Status: '0' }, { Path: 'C:\\Other.exe' }, { Path: null }, { Name: 'Other' }, { Status: undefined }])('rejects incomplete/untrusted signature %j', override => {
    expect(() => validateWindowsSignature(file, ['Publisher'], JSON.stringify({ ...valid, ...override }))).toThrow()
  })
  it.each(['', '{', 'null', '[]', '{}'])('rejects missing or malformed verifier output %s', output => {
    expect(() => validateWindowsSignature(file, ['Publisher'], output)).toThrow()
  })
  it('does not allow an empty publisher list or substring match', () => {
    expect(() => validateWindowsSignature(file, [], JSON.stringify(valid))).toThrow()
    expect(() => validateWindowsSignature(file, [''], JSON.stringify(valid))).toThrow()
    expect(() => validateWindowsSignature(file, ['Publish'], JSON.stringify(valid))).toThrow()
  })
})

const folders: string[] = []
async function userData() {
  const path = join(process.cwd(), `.updates-preferences-test-${randomUUID()}`)
  folders.push(path)
  await mkdir(path)
  return path
}
afterEach(async () => { await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('update preferences', () => {
  it('defaults on missing configuration and persists opt-out atomically', async () => {
    const folder = await userData()
    const preferences = fileUpdatePreferences(folder)
    expect(await preferences.load()).toBe(true)
    await preferences.save(false)
    expect(await fileUpdatePreferences(folder).load()).toBe(false)
    await preferences.save(true)
    expect(JSON.parse(await readFile(join(folder, 'update-preferences.json'), 'utf8'))).toEqual({ schemaVersion: 1, autoCheck: true })
    expect(await readdir(folder)).toEqual(['update-preferences.json'])
  })
  it.each(['{', '{}', '{"schemaVersion":1,"autoCheck":"false"}', '{"schemaVersion":2,"autoCheck":false}', '{"schemaVersion":1,"autoCheck":true,"url":"https://evil.invalid"}'])('does not silently ignore malformed configuration %s', async content => {
    const folder = await userData()
    await writeFile(join(folder, 'update-preferences.json'), content)
    await expect(fileUpdatePreferences(folder).load()).rejects.toThrow()
    await fileUpdatePreferences(folder).save(false)
    expect(await fileUpdatePreferences(folder).load()).toBe(false)
  })
})
