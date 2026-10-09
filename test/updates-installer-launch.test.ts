// @vitest-environment node
import { ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { launchNsisInstaller } from '../src/main/updates/installerLaunch'

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(), spawn: mocked.spawn,
}))
beforeEach(() => { vi.clearAllMocks() })

describe('verified NSIS process launch', () => {
  it('waits for the spawn event, not just an allocated process object or PID', async () => {
    const child = new ChildProcess()
    const unref = vi.spyOn(child, 'unref')
    mocked.spawn.mockReturnValue(child)
    let completed = false
    const launching = launchNsisInstaller('C:\\Update cache\\verified.exe').then(() => { completed = true })
    await Promise.resolve()
    expect(completed).toBe(false)
    expect(mocked.spawn).toHaveBeenCalledExactlyOnceWith('C:\\Update cache\\verified.exe', ['--updated', '--force-run'], {
      detached: true, stdio: 'ignore', windowsHide: true,
    })
    child.emit('spawn')
    await launching
    expect(unref).toHaveBeenCalledOnce()
    expect(child.listenerCount('error')).toBe(0)
  })

  it('rejects delayed launch errors without elevation or an unverified shell fallback', async () => {
    const child = new ChildProcess()
    const unref = vi.spyOn(child, 'unref')
    mocked.spawn.mockReturnValue(child)
    const launching = launchNsisInstaller('C:\\Update cache\\verified.exe')
    const failure = expect(launching).rejects.toThrow('EPERM')
    queueMicrotask(() => child.emit('error', new Error('EPERM')))
    await failure
    expect(mocked.spawn).toHaveBeenCalledOnce()
    expect(unref).not.toHaveBeenCalled()
    expect(child.listenerCount('spawn')).toBe(0)
  })

  it('rejects synchronous spawn errors', async () => {
    mocked.spawn.mockImplementationOnce(() => { throw new Error('Spawn unavailable') })
    await expect(launchNsisInstaller('C:\\verified.exe')).rejects.toThrow('Spawn unavailable')
  })
})
