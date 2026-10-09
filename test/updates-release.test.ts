// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchLatestRelease, isNewer, LATEST_RELEASE_API, parseRelease, stableVersion, validateReleaseCandidate } from '../src/main/updates/release'
import { createElectronInstaller, validateInstallerMetadata } from '../src/main/updates/updater'

const mock = vi.hoisted(() => {
  const listeners = new Map<string, Set<(value: never) => void>>()
  const updater = {
    checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
    on: vi.fn((event: string, callback: (value: never) => void) => {
      const set = listeners.get(event) ?? new Set()
      set.add(callback); listeners.set(event, set)
    }),
    removeListener: vi.fn((event: string, callback: (value: never) => void) => { listeners.get(event)?.delete(callback) }),
    autoDownload: true, autoInstallOnAppQuit: true, allowDowngrade: true, allowPrerelease: true,
    disableWebInstaller: false, disableDifferentialDownload: false,
    verifyUpdateCodeSignature: undefined as undefined | ((names: string[], path: string) => Promise<string | null>),
  }
  const constructor = vi.fn(function () { return updater })
  return { updater, constructor, listeners, launch: vi.fn<(file: string) => Promise<void>>(), quit: vi.fn() }
})
vi.mock('electron-updater', () => ({ NsisUpdater: mock.constructor }))
vi.mock('electron', () => ({ app: { quit: mock.quit } }))
vi.mock('../src/main/updates/installerLaunch', () => ({ launchNsisInstaller: mock.launch }))

function githubRelease() {
  return {
    tag_name: 'v0.2.0', name: 'Version 0.2.0', body: '<b>Release notes are plain data</b>',
    html_url: 'https://github.com/Leoncl2025/TaskContinuum/releases/tag/v0.2.0', draft: false, prerelease: false,
    assets: ['TaskContinuum-0.2.0-win-x64-setup.exe', 'latest.yml'].map(name => ({
      name, size: 100, browser_download_url: `https://github.com/Leoncl2025/TaskContinuum/releases/download/v0.2.0/${name}`,
    })),
  }
}
const release = parseRelease(githubRelease())
const payload = Buffer.from('installer bytes for validation')
const sha512 = createHash('sha512').update(payload).digest('base64')
const metadata = () => ({ version: '0.2.0', tag: 'v0.2.0', files: [{ url: release.installerName, sha512 }] })
function emit(event: string, value: unknown) {
  for (const listener of mock.listeners.get(event) ?? []) listener(value as never)
}
const paths: string[] = []
async function downloadedFile(bytes = payload) {
  const path = join(process.cwd(), `.updates-installer-test-${randomUUID()}.exe`)
  paths.push(path)
  await writeFile(path, bytes)
  return path
}
beforeEach(() => {
  vi.clearAllMocks()
  mock.listeners.clear()
  mock.updater.checkForUpdates.mockReset()
  mock.updater.downloadUpdate.mockReset()
  mock.updater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: metadata() })
  mock.launch.mockReset().mockResolvedValue(undefined)
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(paths.splice(0).map(path => rm(path, { force: true })))
})

describe('stable GitHub releases', () => {
  it.each(['1.2.3', '0.0.0', '10.20.300'])('accepts strict stable version %s', version => { expect(stableVersion(version)).toBe(version) })
  it.each(['v1.2.3', '1.2', '01.2.3', '1.2.3-beta.1', '1.2.3+build', ' 1.2.3', '1.2.3 ', 'latest', '', null])('rejects non-stable version %s', version => {
    expect(() => stableVersion(version)).toThrow()
  })
  it('compares numeric version components', () => {
    expect(isNewer('0.10.0', '0.9.9')).toBe(true)
    expect(isNewer('0.2.0', '0.2.0')).toBe(false)
    expect(isNewer('0.1.9', '0.2.0')).toBe(false)
  })
  it('parses untrusted response into bounded plain release data', () => {
    expect(parseRelease(githubRelease())).toMatchObject({ version: '0.2.0', notes: '<b>Release notes are plain data</b>', hasInstaller: true })
    expect(parseRelease({ ...githubRelease(), body: 'x'.repeat(200_000) }).notes).toHaveLength(100_000)
    expect(parseRelease({ ...githubRelease(), assets: [] }).hasInstaller).toBe(false)
  })
  it.each([
    { draft: true }, { prerelease: true }, { tag_name: 'v0.2.0-beta.1' }, { tag_name: 'v00.2.0' },
    { html_url: 'https://evil.invalid' }, { assets: null }, { body: {} }, { name: [] },
  ])('rejects invalid release %j', override => {
    expect(() => parseRelease({ ...githubRelease(), ...override })).toThrow()
  })
  it.each([
    { name: '../installer.exe' }, { size: 0 }, { browser_download_url: 'https://evil.invalid/installer.exe' },
    { browser_download_url: 'https://github.com/Other/Repo/releases/download/v0.2.0/installer.exe' },
  ])('rejects invalid asset %j', override => {
    const input = githubRelease()
    input.assets[0] = { ...input.assets[0], ...override }
    expect(() => parseRelease(input)).toThrow()
  })
  it('rejects duplicate assets', () => {
    const input = githubRelease()
    input.assets.push(input.assets[0])
    expect(() => parseRelease(input)).toThrow()
  })
  it.each([
    { version: '0.3.0' }, { tag: '0.2.0' }, { installerName: 'other-setup.exe' },
    { url: 'https://github.com/Other/Repo/releases/tag/v0.2.0' },
  ])('keeps the selected version, tag, URL and installer bound together: %j', override => {
    expect(() => validateReleaseCandidate({ ...release, ...override })).toThrow()
  })
  it('uses only fixed unauthenticated GitHub endpoint and rejects HTTP failures', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(githubRelease()) })
    vi.stubGlobal('fetch', fetcher)
    expect(await fetchLatestRelease()).toMatchObject({ version: '0.2.0' })
    expect(fetcher).toHaveBeenCalledWith(LATEST_RELEASE_API, expect.objectContaining({ redirect: 'error', headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } }))
    fetcher.mockResolvedValueOnce({ ok: false, status: 403 })
    await expect(fetchLatestRelease()).rejects.toThrow('HTTP 403')
    fetcher.mockResolvedValueOnce({ ok: true, text: async () => 'not JSON' })
    await expect(fetchLatestRelease()).rejects.toThrow()
  })
})

describe('real Electron installer adapter', () => {
  it('uses fixed public feed and disables automatic download, quit installation, downgrade and prerelease', () => {
    createElectronInstaller(['Publisher'])
    expect(mock.constructor).toHaveBeenCalledWith({ provider: 'github', owner: 'Leoncl2025', repo: 'TaskContinuum', private: false })
    expect(mock.updater).toMatchObject({
      autoDownload: false, autoInstallOnAppQuit: false, allowDowngrade: false,
      allowPrerelease: false, disableWebInstaller: true, disableDifferentialDownload: true,
    })
    expect(mock.updater.checkForUpdates).not.toHaveBeenCalled()
    expect(mock.updater.quitAndInstall).not.toHaveBeenCalled()
    expect(() => createElectronInstaller([])).toThrow()
    expect(() => createElectronInstaller([''])).toThrow()
  })
  it.each([
    { version: '0.3.0' }, { version: '0.1.0' }, { version: '0.2.0-beta.1' }, { tag: '0.2.0' },
    { files: [] }, { files: [{ url: 'https://evil.invalid/setup.exe', sha512 }] },
    { files: [{ url: '../setup.exe', sha512 }] },
    { files: [{ url: release.installerName, sha512: 'missing' }] },
    { packages: {} },
  ])('rejects metadata race/unsafe data %j before download', async override => {
    const info = { ...metadata(), ...override }
    expect(() => validateInstallerMetadata(info, release)).toThrow()
    mock.updater.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: info })
    const installer = createElectronInstaller(['Publisher'], vi.fn(async () => {}))
    await expect(installer.download(release, () => {})).rejects.toThrow()
    expect(mock.updater.downloadUpdate).not.toHaveBeenCalled()
    await expect(installer.install()).rejects.toThrow('No verified')
    installer.close()
  })
  it('rechecks checksum and signature for cached files and again immediately before install', async () => {
    const path = await downloadedFile()
    mock.updater.downloadUpdate.mockResolvedValue([path])
    const verify = vi.fn(async () => {})
    const installer = createElectronInstaller(['Publisher'], verify)
    await installer.download(release, () => {})
    expect(verify).toHaveBeenCalledWith(path, ['Publisher'])
    expect(mock.updater.quitAndInstall).not.toHaveBeenCalled()
    await installer.install()
    expect(verify).toHaveBeenCalledTimes(2)
    expect(mock.launch).toHaveBeenCalledExactlyOnceWith(path)
    expect(mock.quit).toHaveBeenCalledOnce()
    expect(mock.updater.quitAndInstall).not.toHaveBeenCalled()
    await expect(installer.install()).rejects.toThrow()
    installer.close()
  })
  it('rejects checksum corruption before signature and retries successfully', async () => {
    const path = await downloadedFile(Buffer.from('corrupted'))
    mock.updater.downloadUpdate.mockResolvedValue([path])
    const verify = vi.fn(async () => {})
    const installer = createElectronInstaller(['Publisher'], verify)
    await expect(installer.download(release, () => {})).rejects.toThrow('checksum')
    expect(verify).not.toHaveBeenCalled()
    await expect(installer.install()).rejects.toThrow()
    await writeFile(path, payload)
    await installer.download(release, () => {})
    await installer.install()
    expect(mock.launch).toHaveBeenCalledTimes(1)
    expect(mock.quit).toHaveBeenCalledOnce()
    installer.close()
  })
  it('rejects invalid publisher and unavailable signature verification without a bypass', async () => {
    const path = await downloadedFile()
    mock.updater.downloadUpdate.mockResolvedValue([path])
    const verify = vi.fn(async () => { throw new Error('Untrusted publisher') })
    const installer = createElectronInstaller(['Publisher'], verify)
    await expect(mock.updater.verifyUpdateCodeSignature!([], path)).rejects.toThrow('Untrusted publisher')
    await expect(installer.download(release, () => {})).rejects.toThrow('Untrusted publisher')
    await expect(installer.install()).rejects.toThrow()
    expect(mock.updater.quitAndInstall).not.toHaveBeenCalled()
    installer.close()
  })

  it('does not quit on asynchronous installer launch failure', async () => {
    const path = await downloadedFile()
    mock.updater.downloadUpdate.mockResolvedValue([path])
    mock.launch.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      queueMicrotask(() => reject(Object.assign(new Error('Installer launch denied'), { code: 'EPERM' })))
    }))
    const installer = createElectronInstaller(['Publisher'], async () => {})
    await installer.download(release, () => {})
    await expect(installer.install()).rejects.toThrow('Installer launch denied')
    expect(mock.quit).not.toHaveBeenCalled()
    expect(mock.updater.quitAndInstall).not.toHaveBeenCalled()
    installer.close()
  })

  it('waits for successful installer launch before quitting', async () => {
    const path = await downloadedFile()
    mock.updater.downloadUpdate.mockResolvedValue([path])
    let finish = () => {}
    mock.launch.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve }))
    const installer = createElectronInstaller(['Publisher'], async () => {})
    await installer.download(release, () => {})
    const installing = installer.install()
    await vi.waitFor(() => expect(mock.launch).toHaveBeenCalledOnce())
    expect(mock.quit).not.toHaveBeenCalled()
    finish()
    await installing
    expect(mock.quit).toHaveBeenCalledOnce()
    installer.close()
  })
  it('rejects tampering between download and explicit installation', async () => {
    const path = await downloadedFile()
    mock.updater.downloadUpdate.mockResolvedValue([path])
    const installer = createElectronInstaller(['Publisher'], async () => {})
    await installer.download(release, () => {})
    await writeFile(path, 'changed')
    await expect(installer.install()).rejects.toThrow('checksum')
    expect(mock.updater.quitAndInstall).not.toHaveBeenCalled()
    installer.close()
  })
  it('does not expose stale installer after a later network failure', async () => {
    const path = await downloadedFile()
    mock.updater.downloadUpdate.mockResolvedValue([path])
    const installer = createElectronInstaller(['Publisher'], async () => {})
    await installer.download(release, () => {})
    mock.updater.checkForUpdates.mockRejectedValueOnce(new Error('Network disconnected'))
    await expect(installer.download(release, () => {})).rejects.toThrow('Network disconnected')
    await expect(installer.install()).rejects.toThrow()
    installer.close()
  })
  it('does not use a release candidate whose version and tag disagree', async () => {
    const installer = createElectronInstaller(['Publisher'], async () => {})
    await expect(installer.download({ ...release, version: '0.3.0' }, () => {})).rejects.toThrow('Invalid selected release')
    expect(mock.updater.checkForUpdates).not.toHaveBeenCalled()
    expect(mock.updater.downloadUpdate).not.toHaveBeenCalled()
    installer.close()
  })
  it('pins a copy of the selected release while checking metadata', async () => {
    const path = await downloadedFile()
    const selected = { ...release }
    mock.updater.checkForUpdates.mockImplementationOnce(async () => {
      selected.version = '0.3.0'
      selected.tag = 'v0.3.0'
      return { isUpdateAvailable: true, updateInfo: metadata() }
    })
    mock.updater.downloadUpdate.mockResolvedValue([path])
    const installer = createElectronInstaller(['Publisher'], async () => {})
    await installer.download(selected, () => {})
    await installer.install()
    expect(mock.launch).toHaveBeenCalledExactlyOnceWith(path)
    installer.close()
  })
  it('rejects metadata checksum changes instead of trusting a changed download result', async () => {
    const path = await downloadedFile()
    const info = metadata()
    mock.updater.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: info })
    mock.updater.downloadUpdate.mockImplementationOnce(async () => {
      info.files[0].sha512 = createHash('sha512').update('different installer').digest('base64')
      return [path]
    })
    const verify = vi.fn(async () => {})
    const installer = createElectronInstaller(['Publisher'], verify)
    await expect(installer.download(release, () => {})).rejects.toThrow('metadata changed')
    expect(verify).not.toHaveBeenCalled()
    await expect(installer.install()).rejects.toThrow('No verified')
    installer.close()
  })
  it.each([
    { version: '0.3.0' }, { tag: '0.2.0' },
    { files: [{ url: release.installerName, sha512: createHash('sha512').update('other installer').digest('base64') }] },
    { files: [{ url: 'https://untrusted.invalid/setup.exe', sha512 }] },
  ])('revalidates downloaded-event metadata against the pinned release: %j', async override => {
    const path = await downloadedFile()
    mock.updater.downloadUpdate.mockImplementationOnce(async () => {
      emit('update-downloaded', { ...metadata(), ...override, downloadedFile: path })
      return [path]
    })
    const verify = vi.fn(async () => {})
    const installer = createElectronInstaller(['Publisher'], verify)
    await expect(installer.download(release, () => {})).rejects.toThrow()
    expect(verify).not.toHaveBeenCalled()
    await expect(installer.install()).rejects.toThrow('No verified')
    expect(mock.listeners.get('update-downloaded')?.size).toBe(0)
    installer.close()
  })
  it('checks metadata again after final signature verification', async () => {
    const path = await downloadedFile()
    const info = metadata()
    mock.updater.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: info })
    mock.updater.downloadUpdate.mockResolvedValue([path])
    const installer = createElectronInstaller(['Publisher'], async () => { info.version = '0.3.0' })
    await expect(installer.download(release, () => {})).rejects.toThrow('release changed')
    await expect(installer.install()).rejects.toThrow('No verified')
    expect(mock.quit).not.toHaveBeenCalled()
    installer.close()
  })
  it('does not expose readiness when a resolved download also reports an updater error', async () => {
    const path = await downloadedFile()
    mock.updater.downloadUpdate.mockImplementationOnce(async () => {
      emit('error', new Error('Updater download failure'))
      return [path]
    })
    const installer = createElectronInstaller(['Publisher'], async () => {})
    const error = vi.fn()
    installer.onError!(error)
    await expect(installer.download(release, () => {})).rejects.toThrow('Installer reported an error')
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'Updater download failure' }))
    await expect(installer.install()).rejects.toThrow('No verified')
    expect(mock.quit).not.toHaveBeenCalled()
    installer.close()
  })
  it('does not launch if an updater error arrives during the final pre-install verification', async () => {
    const path = await downloadedFile()
    mock.updater.downloadUpdate.mockResolvedValue([path])
    const verify = vi.fn(async () => {})
    const installer = createElectronInstaller(['Publisher'], verify)
    await installer.download(release, () => {})
    verify.mockImplementationOnce(async () => { emit('error', new Error('Cached installer unavailable')) })
    await expect(installer.install()).rejects.toThrow('Installer reported an error before launch')
    expect(mock.launch).not.toHaveBeenCalled()
    expect(mock.quit).not.toHaveBeenCalled()
    installer.close()
  })
  it('cancels in-flight downloads on shutdown without exposing an installable file', async () => {
    const path = await downloadedFile()
    const cancel = vi.fn()
    mock.updater.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: metadata(), cancellationToken: { cancel } })
    let complete!: (paths: string[]) => void
    mock.updater.downloadUpdate.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const installer = createElectronInstaller(['Publisher'], async () => {})
    const downloading = installer.download(release, () => {})
    await vi.waitFor(() => expect(mock.updater.downloadUpdate).toHaveBeenCalledOnce())
    installer.close()
    expect(cancel).toHaveBeenCalledOnce()
    complete([path])
    await expect(downloading).rejects.toThrow('closed')
    await expect(installer.install()).rejects.toThrow('No verified')
    expect(mock.quit).not.toHaveBeenCalled()
  })
  it('removes progress listeners after errors and never installs on close', async () => {
    mock.updater.downloadUpdate.mockRejectedValue(new Error('Download failed'))
    const installer = createElectronInstaller(['Publisher'], async () => {})
    await expect(installer.download(release, () => {})).rejects.toThrow('Download failed')
    expect(mock.listeners.get('download-progress')?.size).toBe(0)
    expect(mock.listeners.get('update-downloaded')?.size).toBe(0)
    installer.close()
    expect(mock.updater.quitAndInstall).not.toHaveBeenCalled()
  })
})
