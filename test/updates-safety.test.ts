import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerInstallSafety, updateBlockers } from '../src/renderer/installSafety'
import type { UpdateBridge } from '../src/shared/updates'

afterEach(() => { document.body.replaceChildren(); document.body.inert = false })

function fixture() {
  let prepare: (id: string) => void = () => { throw new Error('No preparation listener') }
  let aborted: () => void = () => { throw new Error('No abort listener') }
  const disposePrepare = vi.fn()
  const disposeAbort = vi.fn()
  const bridge: Pick<UpdateBridge, 'onPrepareInstall' | 'respondToInstall' | 'onInstallAborted'> = {
    onPrepareInstall: (listener) => { prepare = listener; return disposePrepare },
    onInstallAborted: (listener) => { aborted = listener; return disposeAbort },
    respondToInstall: vi.fn(async () => {}),
  }
  const error = vi.fn()
  const dispose = registerInstallSafety(bridge, document, error)
  return { bridge, prepare: (id: string) => prepare(id), abort: () => aborted(), dispose, disposePrepare, disposeAbort, error }
}

describe('renderer update safety', () => {
  it('includes hidden panes and deduplicates blockers without reading private content', () => {
    const pane = document.createElement('aside')
    pane.hidden = true
    pane.dataset.updateBlocker = 'Unsent text or images'
    document.body.append(pane, pane.cloneNode())
    expect(updateBlockers(document)).toEqual(['Unsent text or images'])
  })

  it('freezes input until main confirms an abort, preserving draft content', () => {
    const { bridge, prepare, abort, dispose } = fixture()
    const draft = document.createElement('textarea')
    draft.value = 'Keep my private draft'
    draft.dataset.updateBlocker = 'Send or clear unsent draft'
    document.body.append(draft)
    const dialog = document.createElement('dialog')
    dialog.open = true
    dialog.inert = false
    document.body.append(dialog)
    document.body.inert = false
    prepare('request')
    expect(document.body.inert).toBe(true)
    expect(dialog.inert).toBe(true)
    expect(bridge.respondToInstall).toHaveBeenCalledWith('request', ['Send or clear unsent draft'])
    const key = new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true })
    document.dispatchEvent(key)
    expect(key.defaultPrevented).toBe(true)
    abort()
    expect(document.body.inert).toBe(false)
    expect(dialog.inert).toBe(false)
    expect(draft.value).toBe('Keep my private draft')
    dispose()
  })

  it('restores preexisting inert state and removes all listeners when disposed', () => {
    document.body.inert = true
    const { prepare, dispose, disposePrepare, disposeAbort } = fixture()
    prepare('request')
    dispose()
    expect(document.body.inert).toBe(true)
    expect(disposePrepare).toHaveBeenCalledOnce()
    expect(disposeAbort).toHaveBeenCalledOnce()
    const key = new KeyboardEvent('keydown', { key: 'p', cancelable: true })
    document.dispatchEvent(key)
    expect(key.defaultPrevented).toBe(false)
  })

  it('unfreezes and reports IPC acknowledgement failure', async () => {
    const { bridge, prepare, dispose, error } = fixture()
    document.body.inert = false
    vi.mocked(bridge.respondToInstall).mockRejectedValue(new Error('Stale restart request'))
    prepare('request')
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('Stale restart request'))
    expect(document.body.inert).toBe(false)
    dispose()
  })
})
