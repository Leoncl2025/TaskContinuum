// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateService } from '../src/main/updates/service'
import type { UpdateServiceOptions } from '../src/main/updates/service'
import type { ReleaseCandidate } from '../src/main/updates/release'

const release: ReleaseCandidate = {
  version: '0.2.0', tag: 'v0.2.0', name: 'Next', notes: '<script>plain data</script>',
  url: 'https://github.com/Leoncl2025/TaskContinuum/releases/tag/v0.2.0',
  installerName: 'TaskContinuum-0.2.0-win-x64-setup.exe', hasInstaller: true,
}
const services: UpdateService[] = []
async function fixture(overrides: Partial<UpdateServiceOptions> = {}, autoCheck = false) {
  const installer = { download: vi.fn(async () => {}), install: vi.fn(async () => {}), close: vi.fn() }
  const preferences = { load: vi.fn(async () => autoCheck), save: vi.fn<(value: boolean) => Promise<void>>(async () => {}) }
  const fetchRelease = vi.fn(async () => ({ ...release }))
  const openExternal = vi.fn(async () => {})
  const prepareInstall = vi.fn(async (install: () => Promise<void>) => { await install() })
  const options: UpdateServiceOptions = {
    currentVersion: '0.1.1', capability: { distribution: 'nsis', canInstall: true, publisherNames: ['Publisher'] },
    installer, preferences, fetchRelease, openExternal, prepareInstall, ...overrides,
  }
  const service = await UpdateService.create(options)
  services.push(service)
  return { service, installer, preferences, fetchRelease, openExternal, prepareInstall }
}
afterEach(() => { for (const service of services.splice(0)) service.close(); vi.useRealTimers() })

describe('update service', () => {
  it('opens the fixed release index without a successful network check', async () => {
    const { service, openExternal, fetchRelease, installer } = await fixture()
    await service.openRelease()
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://github.com/Leoncl2025/TaskContinuum/releases')
    expect(fetchRelease).not.toHaveBeenCalled()
    expect(installer.download).not.toHaveBeenCalled()
    expect(service.state().phase).toBe('idle')
  })

  it('waits for an in-flight preference write before shutdown cleanup can finish', async () => {
    let finish = () => {}
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const preferences = { load: async () => true, save: vi.fn(() => pending) }
    const { service } = await fixture({ preferences })
    const saving = service.setAutoCheck(false)
    await vi.waitFor(() => expect(preferences.save).toHaveBeenCalledOnce())
    let flushed = false
    const flushing = service.flushPreferences().then(() => { flushed = true })
    await Promise.resolve()
    expect(flushed).toBe(false)
    finish()
    await Promise.all([saving, flushing])
    expect(flushed).toBe(true)
    expect(service.state().autoCheck).toBe(false)
  })

  it('checks without downloading when opted out; notes are data and manual links are canonical', async () => {
    const { service, installer, openExternal } = await fixture()
    expect((await service.check()).phase).toBe('available')
    expect(service.state().release?.notes).toBe(release.notes)
    expect(installer.download).not.toHaveBeenCalled()
    await service.openRelease()
    expect(openExternal).toHaveBeenCalledWith(release.url)
    const snapshot = service.state()
    snapshot.release!.url = 'https://evil.invalid'
    await service.openRelease()
    expect(openExternal).toHaveBeenLastCalledWith(release.url)
  })

  it.each(['0.1.1', '0.1.0'])('does not offer equal or older version %s', async version => {
    const { service } = await fixture({ fetchRelease: async () => ({
      ...release, version, tag: `v${version}`, url: release.url.replace('0.2.0', version),
      installerName: `TaskContinuum-${version}-win-x64-setup.exe`,
    }) })
    expect((await service.check()).phase).toBe('up-to-date')
    await expect(service.download()).rejects.toThrow()
  })

  it('coalesces checks and manual downloads, but never starts installation concurrently', async () => {
    let resolve!: (release: ReleaseCandidate) => void
    const network = vi.fn(() => new Promise<ReleaseCandidate>(done => { resolve = done }))
    const { service, installer } = await fixture({ fetchRelease: network })
    let complete!: () => void
    installer.download.mockImplementation(() => new Promise<void>(done => { complete = done }))
    const first = service.check()
    expect(service.check()).toBe(first)
    const requestedDownload = service.download()
    await expect(service.install()).rejects.toThrow()
    resolve(release)
    await first
    expect(network).toHaveBeenCalledTimes(1)
    const downloading = service.download()
    expect(service.download()).toBe(downloading)
    const checkedDuringDownload = service.check()
    expect(service.state().phase).toBe('downloading')
    await expect(service.install()).rejects.toThrow()
    complete()
    await Promise.all([requestedDownload, downloading])
    expect((await checkedDuringDownload).phase).toBe('downloaded')
    await service.download()
    expect(installer.download).toHaveBeenCalledOnce()
    expect((await service.check()).phase).toBe('downloaded')
    expect(network).toHaveBeenCalledTimes(1)
  })

  it('clamps finite monotonic progress and ignores NaN', async () => {
    const seen: number[] = []
    const { service } = await fixture({
      installer: {
        download: async (_release, progress) => { for (const value of [-10, 30, 20, NaN, Infinity, 150]) progress(value) },
        install: async () => {}, close: () => {},
      },
    })
    service.listen(state => { if (state.progress !== undefined) seen.push(state.progress) })
    await service.check()
    await service.download()
    expect(seen).toEqual([0, 0, 30, 30, 100, 100])
  })

  it.each(['Network timeout', 'Checksum mismatch', 'Invalid signature'])('surfaces %s and safely retries', async failure => {
    const { service, installer } = await fixture()
    await service.check()
    installer.download.mockRejectedValueOnce(new Error(failure))
    await expect(service.download()).rejects.toThrow(failure)
    expect(service.state()).toMatchObject({ phase: 'error', error: failure })
    expect(service.state().progress).toBeUndefined()
    await expect(service.install()).rejects.toThrow('No verified')
    await service.download()
    expect(service.state().phase).toBe('downloaded')
    await service.install()
    expect(installer.install).toHaveBeenCalledTimes(1)
    expect((await service.check()).phase).toBe('installing')
    await expect(service.install()).rejects.toThrow()
  })

  it('clears stale ready state when asynchronous updater errors arrive', async () => {
    let report!: (error: Error) => void
    const { service } = await fixture({
      installer: {
        download: async () => {}, install: async () => {}, close: () => {},
        onError(listener) { report = listener; return () => {} },
      },
    })
    await service.check()
    await service.download()
    report(new Error('Cached file invalid'))
    await expect(service.install()).rejects.toThrow()
    expect(service.state().phase).toBe('error')
    await service.download()
    expect(service.state().phase).toBe('downloaded')
  })

  it('does not treat a resolved download as verified if it emitted an error', async () => {
    let report!: (error: Error) => void
    const { service } = await fixture({
      installer: {
        download: async () => { report(new Error('Signature failure')) }, install: async () => {}, close: () => {},
        onError(listener) { report = listener; return () => {} },
      },
    })
    await service.check()
    await expect(service.download()).rejects.toThrow('Signature failure')
    await expect(service.install()).rejects.toThrow()
  })

  it('retains verified download on preparation veto and allows retry', async () => {
    const { service, installer, prepareInstall } = await fixture()
    await service.check()
    await service.download()
    prepareInstall.mockRejectedValueOnce(new Error('Workspace dirty'))
    await expect(service.install()).rejects.toThrow('Workspace dirty')
    expect(service.state().phase).toBe('downloaded')
    expect(installer.install).not.toHaveBeenCalled()
    await service.install()
    expect(installer.install).toHaveBeenCalledTimes(1)
  })

  it('serializes installs and only hands the installer thunk to preparation once', async () => {
    let allow!: () => void
    const prepareInstall = vi.fn(async (install: () => Promise<void>) => {
      await new Promise<void>(done => { allow = done })
      await install()
      await expect(install()).rejects.toThrow()
    })
    const { service, installer } = await fixture({ prepareInstall })
    await service.check()
    await service.download()
    const installing = service.install()
    await expect(service.install()).rejects.toThrow()
    await expect(service.download()).rejects.toThrow()
    expect((await service.check()).phase).toBe('installing')
    allow()
    await installing
    expect(installer.install).toHaveBeenCalledTimes(1)
  })

  it('supports manual-only archive releases and missing installer metadata', async () => {
    const { service, installer } = await fixture({ capability: { distribution: 'archive', canInstall: false, publisherNames: [], reason: 'Manual only' } })
    expect((await service.check()).phase).toBe('available')
    await expect(service.download()).rejects.toThrow('Manual only')
    expect(installer.download).not.toHaveBeenCalled()
    const missing = await fixture({ fetchRelease: async () => ({ ...release, hasInstaller: false }) })
    expect(await missing.service.check()).toMatchObject({ phase: 'available', canInstall: false, reason: expect.stringContaining('manually') })
  })

  it('surfaces failed release checks and rejects untrusted links', async () => {
    const { service, fetchRelease, openExternal } = await fixture()
    fetchRelease.mockRejectedValueOnce(new Error('HTTP 403'))
    expect(await service.check()).toMatchObject({ phase: 'error', error: 'HTTP 403' })
    fetchRelease.mockResolvedValueOnce({ ...release, url: 'https://evil.invalid/' })
    expect((await service.check()).phase).toBe('error')
    await service.openRelease()
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://github.com/Leoncl2025/TaskContinuum/releases')
    expect((await service.check()).phase).toBe('available')
  })

  it('loads preferences safely and keeps malformed configuration visible without startup traffic', async () => {
    vi.useFakeTimers()
    const { service, fetchRelease } = await fixture({ preferences: { load: async () => { throw new Error('Malformed JSON') }, save: async () => {} } })
    expect(service.state()).toMatchObject({ phase: 'error', autoCheck: false, error: expect.stringContaining('Malformed JSON') })
    service.start()
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000)
    expect(fetchRelease).not.toHaveBeenCalled()
  })

  it('uses delayed periodic checks, persists opt-out across restart, and disposes timers', async () => {
    vi.useFakeTimers()
    let enabled = true
    const preferences = { load: async () => enabled, save: async (value: boolean) => { enabled = value } }
    const first = await fixture({ currentVersion: '0.2.0', preferences, startupDelayMs: 100, intervalMs: 1000 })
    first.service.start()
    first.service.start()
    await vi.advanceTimersByTimeAsync(99)
    expect(first.fetchRelease).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(first.fetchRelease).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(first.fetchRelease).toHaveBeenCalledTimes(2)
    await first.service.setAutoCheck(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(first.fetchRelease).toHaveBeenCalledTimes(2)
    first.service.close()
    const second = await fixture({ preferences, startupDelayMs: 100 })
    second.service.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(second.fetchRelease).not.toHaveBeenCalled()
    await second.service.setAutoCheck(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(second.fetchRelease).toHaveBeenCalledTimes(1)
    second.service.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never schedules development networking even when opted in', async () => {
    vi.useFakeTimers()
    const { service, fetchRelease } = await fixture({ capability: { distribution: 'development', canInstall: false, publisherNames: [] } })
    service.start()
    await service.setAutoCheck(true)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(fetchRelease).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    await service.check()
    expect(fetchRelease).toHaveBeenCalledTimes(1)
  })

  it('aborts shutdown checks without publishing stale state', async () => {
    let complete!: (value: ReleaseCandidate) => void
    let signal!: AbortSignal
    const { service } = await fixture({ fetchRelease: input => { signal = input; return new Promise(resolve => { complete = resolve }) } })
    const listener = vi.fn()
    service.listen(listener)
    const checking = service.check()
    await Promise.resolve()
    service.close()
    expect(signal.aborted).toBe(true)
    complete(release)
    await checking
    expect(listener).toHaveBeenCalledTimes(1)
    await expect(service.check()).rejects.toThrow('closed')
  })

  it('retains the saved preference on persistence failure and can retry', async () => {
    const { service, preferences } = await fixture({}, true)
    preferences.save.mockRejectedValueOnce(new Error('Permission denied'))
    await expect(service.setAutoCheck(false)).rejects.toThrow()
    expect(service.state()).toMatchObject({ autoCheck: true, error: expect.stringContaining('Permission denied') })
    await service.setAutoCheck(false)
    expect(service.state().autoCheck).toBe(false)
  })

  it('downloads a verified stable update after the default startup delay and waits for explicit restart', async () => {
    vi.useFakeTimers()
    const { service, fetchRelease, installer, prepareInstall } = await fixture({}, true)
    service.start()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(fetchRelease).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchRelease).toHaveBeenCalledOnce()
    expect(installer.download).toHaveBeenCalledExactlyOnceWith(release, expect.any(Function))
    expect(service.state()).toMatchObject({ phase: 'downloaded', autoCheck: true, progress: 100, release: { version: release.version } })
    expect(installer.install).not.toHaveBeenCalled()
    expect(prepareInstall).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(fetchRelease).toHaveBeenCalledOnce()
    expect(installer.download).toHaveBeenCalledOnce()
    service.close()
    expect(installer.install).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('checks every six hours after the default startup check when already up to date', async () => {
    vi.useFakeTimers()
    const { service, fetchRelease, installer } = await fixture({ currentVersion: '0.2.0' }, true)
    service.start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(service.state().phase).toBe('up-to-date')
    expect(fetchRelease).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 - 1)
    expect(fetchRelease).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchRelease).toHaveBeenCalledTimes(2)
    expect(installer.download).not.toHaveBeenCalled()
  })

  it('coalesces automatic downloads with manual requests during both check and download', async () => {
    let found!: (candidate: ReleaseCandidate) => void
    let downloaded!: () => void
    const fetchRelease = vi.fn(() => new Promise<ReleaseCandidate>(resolve => { found = resolve }))
    const { service, installer } = await fixture({ fetchRelease }, true)
    installer.download.mockImplementation(() => new Promise(resolve => { downloaded = resolve }))
    const checking = service.check()
    const requestedWhileChecking = service.download()
    expect(service.check()).toBe(checking)
    await Promise.resolve()
    found(release)
    await vi.waitFor(() => expect(installer.download).toHaveBeenCalledOnce())
    const requestedWhileDownloading = service.download()
    expect(service.download()).toBe(requestedWhileDownloading)
    expect(service.check()).toBe(checking)
    downloaded()
    await Promise.all([checking, requestedWhileChecking, requestedWhileDownloading])
    expect(service.state().phase).toBe('downloaded')
    expect(fetchRelease).toHaveBeenCalledOnce()
    expect(installer.download).toHaveBeenCalledOnce()
    expect(installer.install).not.toHaveBeenCalled()
  })

  it('surfaces an automatic download failure and retries only on the next interval', async () => {
    vi.useFakeTimers()
    const { service, fetchRelease, installer } = await fixture({ startupDelayMs: 100, intervalMs: 1000 }, true)
    installer.download.mockRejectedValueOnce(new Error('Signature verification failed'))
    service.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(service.state()).toMatchObject({ phase: 'error', error: 'Signature verification failed', release: { version: release.version } })
    await expect(service.install()).rejects.toThrow('No verified')
    await vi.advanceTimersByTimeAsync(999)
    expect(fetchRelease).toHaveBeenCalledOnce()
    expect(installer.download).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchRelease).toHaveBeenCalledTimes(2)
    expect(installer.download).toHaveBeenCalledTimes(2)
    expect(service.state().phase).toBe('downloaded')
    expect(installer.install).not.toHaveBeenCalled()
  })

  it('does not retry a failed automatic download for a manual request already waiting on the check', async () => {
    const { service, installer } = await fixture({}, true)
    installer.download.mockRejectedValueOnce(new Error('Network disconnected'))
    const checking = service.check()
    const downloading = service.download()
    await expect(downloading).rejects.toThrow('Network disconnected')
    expect((await checking).phase).toBe('error')
    expect(installer.download).toHaveBeenCalledOnce()
    await service.download()
    expect(installer.download).toHaveBeenCalledTimes(2)
    expect(service.state().phase).toBe('downloaded')
  })

  it('honors an in-flight opt-out before beginning an automatic download', async () => {
    let found!: (candidate: ReleaseCandidate) => void
    let saved!: () => void
    const preferences = { load: async () => true, save: vi.fn(() => new Promise<void>(resolve => { saved = resolve })) }
    const { service, installer } = await fixture({
      preferences, fetchRelease: () => new Promise(resolve => { found = resolve }),
    })
    const checking = service.check()
    const optingOut = service.setAutoCheck(false)
    await vi.waitFor(() => expect(preferences.save).toHaveBeenCalledWith(false))
    found(release)
    await Promise.resolve()
    expect(installer.download).not.toHaveBeenCalled()
    saved()
    await Promise.all([checking, optingOut])
    expect(service.state()).toMatchObject({ phase: 'available', autoCheck: false })
    expect(installer.download).not.toHaveBeenCalled()
    await service.download()
    expect(service.state().phase).toBe('downloaded')
  })

  it.each(['archive', 'development', 'unsupported', 'nsis'] as const)('never automatically downloads ineligible %s builds', async distribution => {
    const { service, installer } = await fixture({
      capability: { distribution, canInstall: false, publisherNames: [], reason: 'Manual updates only' },
    }, true)
    expect((await service.check()).phase).toBe('available')
    expect(installer.download).not.toHaveBeenCalled()
    await expect(service.download()).rejects.toThrow('Manual updates only')
  })

  it('leaves releases without full installer metadata manual-only, even when opted in', async () => {
    const { service, installer } = await fixture({ fetchRelease: async () => ({ ...release, hasInstaller: false }) }, true)
    expect(await service.check()).toMatchObject({ phase: 'available', canInstall: false })
    expect(installer.download).not.toHaveBeenCalled()
  })

  it('surfaces installer launch failure, invalidates readiness, and allows explicit redownload', async () => {
    const { service, installer } = await fixture()
    await service.check()
    await service.download()
    installer.install.mockRejectedValueOnce(new Error('Installer launch failed'))
    await expect(service.install()).rejects.toThrow('Installer launch failed')
    expect(service.state()).toMatchObject({ phase: 'error', error: 'Installer launch failed', release: { version: release.version } })
    await expect(service.install()).rejects.toThrow('No verified')
    await service.download()
    await service.install()
    expect(installer.install).toHaveBeenCalledTimes(2)
  })

  it('keeps a download error visible when automatic updates are disabled', async () => {
    const { service, installer } = await fixture({}, true)
    installer.download.mockRejectedValueOnce(new Error('Checksum mismatch'))
    await service.check()
    await service.setAutoCheck(false)
    expect(service.state()).toMatchObject({ phase: 'error', error: 'Checksum mismatch', autoCheck: false })
  })

  it('allows retries after a synchronous release-check failure', async () => {
    const fetchRelease = vi.fn(() => { throw new Error('Check unavailable') })
    const { service } = await fixture({ fetchRelease })
    expect(await service.check()).toMatchObject({ phase: 'error', error: 'Check unavailable' })
    expect((await service.check()).phase).toBe('error')
    expect(fetchRelease).toHaveBeenCalledTimes(2)
  })
})
