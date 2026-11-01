// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { DesktopOperations } from '../src/main/desktopOperations'
import { UpdateRestartGuard } from '../src/main/updateRestartGuard'

function fixture() {
  const operations = new DesktopOperations()
  const dependencies = {
    operations,
    requestRenderer: vi.fn<(id: string) => void>(),
    resumeRenderer: vi.fn(),
    rendererAvailable: vi.fn(() => true),
    hasActiveWork: vi.fn(() => false),
    cleanup: vi.fn(async () => {}),
    timeoutMs: 10,
  }
  const guard = new UpdateRestartGuard(dependencies)
  const installer = vi.fn()
  return { dependencies, operations, guard, installer }
}

describe('update restart coordination', () => {
  it('waits for a matching renderer acknowledgement and cleanup before invoking the installer', async () => {
    const { dependencies, operations, guard, installer } = fixture()
    const result = guard.install(installer)
    expect(dependencies.cleanup).not.toHaveBeenCalled()
    expect(() => operations.run(() => {})).toThrow('preparing')
    guard.respond(dependencies.requestRenderer.mock.calls[0][0], [])
    await result
    expect(dependencies.cleanup).toHaveBeenCalledOnce()
    expect(installer).toHaveBeenCalledOnce()
    expect(dependencies.cleanup.mock.invocationCallOrder[0]).toBeLessThan(installer.mock.invocationCallOrder[0])
    expect(() => operations.run(() => {})).toThrow('preparing')
    expect(dependencies.resumeRenderer).not.toHaveBeenCalled()
  })

  it('rejects overlapping installs without unlocking the first one', async () => {
    const { dependencies, operations, guard, installer } = fixture()
    const first = guard.install(installer)
    await expect(guard.install(installer)).rejects.toThrow('already')
    expect(() => operations.run(() => {})).toThrow('preparing')
    guard.respond(dependencies.requestRenderer.mock.calls[0][0], [])
    await first
    expect(installer).toHaveBeenCalledOnce()
  })

  it('does not interrupt a pending desktop IPC operation', async () => {
    const { dependencies, operations, guard, installer } = fixture()
    let finish = () => {}
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const operation = operations.run(() => pending)
    await expect(guard.install(installer)).rejects.toThrow('current workspace')
    expect(dependencies.requestRenderer).not.toHaveBeenCalled()
    finish()
    await operation
    dependencies.requestRenderer.mockImplementation((id) => guard.respond(id, []))
    await guard.install(installer)
    expect(installer).toHaveBeenCalledOnce()
  })

  it('releases failed and synchronous operation counters without swallowing failures', async () => {
    const operations = new DesktopOperations()
    expect(() => operations.run(() => { throw new Error('sync failure') })).toThrow('sync failure')
    await expect(operations.run(async () => { throw new Error('async failure') })).rejects.toThrow('async failure')
    expect(operations.run(() => 42)).toBe(42)
    expect(() => operations.lock()).not.toThrow()
  })

  it('blocks unsent drafts and leaves the window usable for retry', async () => {
    const { dependencies, operations, guard, installer } = fixture()
    dependencies.requestRenderer.mockImplementation((id) => guard.respond(id, ['Unsent images', 'Unsent text']))
    await expect(guard.install(installer)).rejects.toThrow('Unsent images Unsent text')
    expect(dependencies.cleanup).not.toHaveBeenCalled()
    expect(installer).not.toHaveBeenCalled()
    expect(dependencies.resumeRenderer).toHaveBeenCalledOnce()
    expect(operations.run(() => 'usable')).toBe('usable')
    dependencies.requestRenderer.mockImplementation((id) => guard.respond(id, []))
    await guard.install(installer)
  })

  it('does not accept an unsolicited or stale acknowledgement', async () => {
    const { dependencies, guard, installer } = fixture()
    expect(() => guard.respond(crypto.randomUUID(), [])).toThrow('no longer current')
    const pending = guard.install(installer)
    expect(() => guard.respond(crypto.randomUUID(), [])).toThrow('no longer current')
    guard.respond(dependencies.requestRenderer.mock.calls[0][0], [])
    await pending
    expect(() => guard.respond(dependencies.requestRenderer.mock.calls[0][0], [])).toThrow('no longer current')
  })

  it('times out closed or unresponsive renderers instead of installing', async () => {
    const { dependencies, guard, installer } = fixture()
    await expect(guard.install(installer)).rejects.toThrow('did not confirm')
    expect(installer).not.toHaveBeenCalled()
    expect(dependencies.cleanup).not.toHaveBeenCalled()
    expect(dependencies.resumeRenderer).toHaveBeenCalledOnce()
  })

  it('rechecks native activity after renderer approval', async () => {
    const { dependencies, guard, installer } = fixture()
    dependencies.requestRenderer.mockImplementation((id) => {
      dependencies.hasActiveWork.mockReturnValue(true)
      guard.respond(id, [])
    })
    await expect(guard.install(installer)).rejects.toThrow('Agent Host')
    expect(dependencies.cleanup).not.toHaveBeenCalled()
    expect(installer).not.toHaveBeenCalled()
  })

  it('never installs if cleanup fails', async () => {
    const { dependencies, operations, guard, installer } = fixture()
    dependencies.requestRenderer.mockImplementation((id) => guard.respond(id, []))
    dependencies.cleanup.mockRejectedValue(new Error('Saving preferences failed'))
    await expect(guard.install(installer)).rejects.toThrow('Saving preferences failed')
    expect(installer).not.toHaveBeenCalled()
    expect(dependencies.resumeRenderer).toHaveBeenCalledExactlyOnceWith(true)
    expect(() => operations.run(() => {})).toThrow('services have stopped')
  })

  it('aborts if the window disappears during cleanup', async () => {
    const { dependencies, guard, installer } = fixture()
    dependencies.requestRenderer.mockImplementation((id) => guard.respond(id, []))
    dependencies.cleanup.mockImplementation(async () => { guard.abort() })
    await expect(guard.install(installer)).rejects.toThrow('window is unavailable')
    expect(installer).not.toHaveBeenCalled()
  })

  it('surfaces installer launch failure and releases the renderer', async () => {
    const { dependencies, operations, guard, installer } = fixture()
    dependencies.requestRenderer.mockImplementation((id) => guard.respond(id, []))
    installer.mockImplementation(() => { throw new Error('Installer could not start') })
    await expect(guard.install(installer)).rejects.toThrow('Installer could not start')
    expect(dependencies.resumeRenderer).toHaveBeenCalledExactlyOnceWith(true)
    expect(() => operations.run(() => {})).toThrow('services have stopped')
    await expect(guard.install(installer)).rejects.toThrow('services have stopped')
  })
})
