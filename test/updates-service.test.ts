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
  it('downloads a newer signed update automatically without installing or prompting twice', async () => {
    const { service, installer, fetchRelease } = await fixture({}, true)
    const phases: string[] = []
    service.listen(state => phases.push(state.phase))
    expect((await service.check()).phase).toBe('downloaded')
    expect(phases).toEqual(['checking', 'available', 'downloading', 'downloaded'])
    expect(installer.download).toHaveBeenCalledExactlyOnceWith(release, expect.any(Function))
    expect(installer.install).not.toHaveBeenCalled()
    await service.check()
    expect(fetchRelease).toHaveBeenCalledOnce()
    expect(installer.download).toHaveBeenCalledOnce()
  })

  it('starts automatic checking and downloading only after the exact 30-second startup delay', async () => {
    vi.useFakeTimers()
    const { service, installer, fetchRelease } = await fixture({}, true)
    service.start()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(fetchRelease).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchRelease).toHaveBeenCalledOnce()
    expect(installer.download).toHaveBeenCalledOnce()
    expect(service.state().phase).toBe('downloaded')
    expect(installer.install).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(fetchRelease).toHaveBeenCalledOnce()
  })

  it('exposes a background download failure without installing and permits an explicit retry', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { service, installer } = await fixture({}, true)
      installer.download.mockRejectedValueOnce(new Error('Network unavailable'))
      expect(await service.check()).toMatchObject({ phase: 'error', error: 'Network unavailable' })
      expect(errorLog).toHaveBeenCalled()
      expect(installer.install).not.toHaveBeenCalled()
      await service.download()
      expect(service.state().phase).toBe('downloaded')
    } finally { errorLog.mockRestore() }
  })

  it('never downloads an unsigned or archive installation even with automatic updates enabled', async () => {
    const { service, installer } = await fixture({ capability: { distribution: 'archive', canInstall: false, publisherNames: [], reason: 'Manual only' } }, true)
    expect((await service.check()).phase).toBe('available')
    expect(installer.download).not.toHaveBeenCalled()
    expect(installer.install).not.toHaveBeenCalled()
  })

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

  it('checks without downloading; notes are only data and manual links are canonical', async () => {
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
    const { service } = await fixture({ fetchRelease: async () => ({ ...release, version, tag: `v${version}`, url: release.url.replace('0.2.0', version) }) })
    expect((await service.check()).phase).toBe('up-to-date')
    await expect(service.download()).rejects.toThrow()
  })

  it('deduplicates concurrent checks and rejects overlapping operations', async () => {
    let resolve!: (release: ReleaseCandidate) => void
    const network = vi.fn(() => new Promise<ReleaseCandidate>(done => { resolve = done }))
    const { service, installer } = await fixture({ fetchRelease: network })
    const first = service.check()
    expect(service.check()).toBe(first)
    await expect(service.download()).rejects.toThrow()
    await expect(service.install()).rejects.toThrow()
    resolve(release)
    await first
    expect(network).toHaveBeenCalledTimes(1)
    let complete!: () => void
    installer.download.mockImplementation(() => new Promise<void>(done => { complete = done }))
    const downloading = service.download()
    expect((await service.check()).phase).toBe('downloading')
    await expect(service.download()).rejects.toThrow()
    await expect(service.install()).rejects.toThrow()
    complete()
    await downloading
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
    const first = await fixture({ preferences, startupDelayMs: 100, intervalMs: 1000, capability: { distribution: 'archive', canInstall: false, publisherNames: [] } })
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
})
