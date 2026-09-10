// @vitest-environment node
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { startVSCodeChatCompanion } from '../src/main/vscodeChatCompanion'
import { vsCodeBridgeConnectUri, vsCodeChatResource } from '../src/shared/vscodeChat'
import { connectOriginalVSCode, openOriginalVSCode, readOriginalVSCode, sendOriginalVSCode } from '../src/main/vscodeChatClient'
import { VSCodeSessionStore } from '../src/main/vscodeSessions'

describe('original chat companion boundary', () => {
  it('restores the source Bridge before one explicit send and stops when the captured context changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continuum-send-connect-'))
    const identity = { workspaceStorageId: 'a'.repeat(32), nativeSessionId: 'original' }
    const history = join(root, identity.workspaceStorageId, 'chatSessions')
    await mkdir(history, { recursive: true })
    await writeFile(join(history, 'original.json'), JSON.stringify({ inputState: { mode: { id: 'agent', kind: 'agent' } }, requests: [{ message: 'Saved original', result: {} }] }))
    const store = new VSCodeSessionStore([root])
    let bridge: Awaited<ReturnType<typeof startVSCodeChatCompanion>> | undefined
    let opened = false
    const open = vi.fn(async () => { opened = true })
    const dispatch = vi.fn(async () => ({ state: 'submitted' as const, nativeRequestId: 'native-new' }))
    const preparation = {
      assertCurrent: vi.fn(async () => {}),
      openExternal: vi.fn(async () => {
        bridge = await startVSCodeChatCompanion({ storageRoot: root, workspaceStorageId: identity.workspaceStorageId, discoveryDirectory: join(root, identity.workspaceStorageId, 'taskcontinuum.vscode-bridge', 'bridges'), vscodeVersion: '1.137.0', open, isOpen: async () => opened, autoOpenOnSend: true, dispatch })
      }),
    }
    try {
      preparation.assertCurrent.mockRejectedValueOnce(new Error('The selected workspace changed.'))
      await expect(sendOriginalVSCode(store, identity, crypto.randomUUID(), 'Do not send', preparation)).rejects.toThrow('workspace changed')
      expect(preparation.openExternal).not.toHaveBeenCalled()
      const commandId = crypto.randomUUID()
      await sendOriginalVSCode(store, identity, commandId, 'Connect and send once', preparation)
      expect(preparation.openExternal).toHaveBeenCalledExactlyOnceWith(vsCodeBridgeConnectUri(identity, 'vscode'))
      expect(open).toHaveBeenCalledExactlyOnceWith(vsCodeChatResource(identity.nativeSessionId))
      await vi.waitFor(async () => expect((await readOriginalVSCode(store, identity)).deliveries?.[0].state).toBe('submitted'))
      expect(dispatch).toHaveBeenCalledOnce()
      await sendOriginalVSCode(store, identity, commandId, 'Connect and send once', preparation)
      expect(preparation.openExternal).toHaveBeenCalledOnce()
      expect(dispatch).toHaveBeenCalledOnce()
    } finally { await bridge?.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('prepares a closed original only for an eligible explicit send and never replays its message ID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continuum-auto-open-'))
    const identity = { workspaceStorageId: 'a'.repeat(32), nativeSessionId: 'original' }
    const history = join(root, identity.workspaceStorageId, 'chatSessions')
    await mkdir(history, { recursive: true })
    const file = join(history, 'original.json')
    const source = { inputState: { mode: { id: 'agent', kind: 'agent' }, inputText: '' }, requests: [{ message: 'Saved original', result: {} }] }
    await writeFile(file, JSON.stringify(source))
    let opened = false
    const open = vi.fn(async () => {})
    const dispatch = vi.fn(async () => ({ state: 'submitted' as const, nativeRequestId: 'native-new' }))
    const bridge = await startVSCodeChatCompanion({ storageRoot: root, workspaceStorageId: identity.workspaceStorageId, discoveryDirectory: join(root, identity.workspaceStorageId, 'taskcontinuum.vscode-bridge', 'bridges'), vscodeVersion: '1.137.0', open, isOpen: async () => opened, autoOpenOnSend: true, dispatch })
    const store = new VSCodeSessionStore([root])
    try {
      expect(await readOriginalVSCode(store, identity)).toMatchObject({ canSend: false, sessionOpen: false, canPrepareSend: true })
      expect(open).not.toHaveBeenCalled()
      for (const blocked of [
        { ...source, inputState: { ...source.inputState, inputText: 'Unsent owner draft' } },
        { ...source, requests: [{ message: 'Still responding' }] },
        { ...source, inputState: { ...source.inputState, mode: { id: 'ask', kind: 'ask' } } },
      ]) {
        await writeFile(file, JSON.stringify(blocked))
        expect(await readOriginalVSCode(store, identity)).toMatchObject({ canSend: false, canPrepareSend: false })
        await expect(sendOriginalVSCode(store, identity, crypto.randomUUID(), 'Must not disturb the owner')).rejects.toThrow()
      }
      expect(open).not.toHaveBeenCalled()
      await writeFile(file, JSON.stringify(source))
      await expect(sendOriginalVSCode(store, identity, crypto.randomUUID(), 'Unready open')).rejects.toThrow('still not open')
      expect(dispatch).not.toHaveBeenCalled()
      expect((await readOriginalVSCode(store, identity)).deliveries).toEqual([])
      open.mockImplementation(async () => { opened = true })
      const commandId = crypto.randomUUID()
      await sendOriginalVSCode(store, identity, commandId, 'Send once after preparing')
      await vi.waitFor(async () => expect((await readOriginalVSCode(store, identity)).deliveries?.[0].state).toBe('submitted'))
      expect(open).toHaveBeenCalledTimes(2)
      expect(open).toHaveBeenLastCalledWith(vsCodeChatResource(identity.nativeSessionId))
      expect(dispatch).toHaveBeenCalledOnce()
      opened = false
      await sendOriginalVSCode(store, identity, commandId, 'Send once after preparing')
      expect(open).toHaveBeenCalledTimes(2)
      expect(dispatch).toHaveBeenCalledOnce()
      expect(await readFile(file, 'utf8')).toBe(JSON.stringify(source))
    } finally { await bridge.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('keeps an online unopened session unsendable and rejects a silent open acknowledgement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continuum-widget-readiness-'))
    const identity = { workspaceStorageId: 'a'.repeat(32), nativeSessionId: 'closed' }
    const history = join(root, identity.workspaceStorageId, 'chatSessions')
    await mkdir(history, { recursive: true })
    await writeFile(join(history, 'closed.json'), JSON.stringify({ inputState: { mode: { id: 'agent', kind: 'agent' } }, requests: [{ message: 'Saved question', result: {} }] }))
    let opened = false
    const open = vi.fn(async () => {})
    const isOpen = vi.fn(async () => opened)
    const dispatch = vi.fn(async () => ({ state: 'submitted' as const, nativeRequestId: 'native-new' }))
    const bridge = await startVSCodeChatCompanion({ storageRoot: root, workspaceStorageId: identity.workspaceStorageId, discoveryDirectory: join(root, identity.workspaceStorageId, 'taskcontinuum.vscode-bridge', 'bridges'), vscodeVersion: '1.137.0', open, isOpen, dispatch })
    const store = new VSCodeSessionStore([root])
    try {
      expect(await readOriginalVSCode(store, identity)).toMatchObject({ connectionState: 'connected', sessionOpen: false, canSend: false })
      await expect(sendOriginalVSCode(store, identity, crypto.randomUUID(), 'Not sent')).rejects.toThrow('not open')
      expect(dispatch).not.toHaveBeenCalled()
      expect((await readOriginalVSCode(store, identity)).deliveries).toEqual([])
      await expect(openOriginalVSCode(store, identity)).rejects.toThrow('still not open')
      open.mockImplementation(async () => { opened = true })
      await openOriginalVSCode(store, identity)
      expect(await readOriginalVSCode(store, identity)).toMatchObject({ connectionState: 'connected', sessionOpen: true, canSend: true })
      const commandId = crypto.randomUUID()
      await sendOriginalVSCode(store, identity, commandId, 'Explicit send')
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
      opened = false
      await sendOriginalVSCode(store, identity, commandId, 'Explicit send')
      expect(dispatch).toHaveBeenCalledOnce()
      expect(await readOriginalVSCode(store, identity)).toMatchObject({ sessionOpen: false, canSend: false })
      await vi.waitFor(async () => expect((await readOriginalVSCode(store, identity)).deliveries?.[0].state).toBe('submitted'))
      const deferred = () => {
        let resolve!: () => void
        const promise = new Promise<void>((complete) => { resolve = complete })
        return { promise, resolve }
      }
      const checkStarted = deferred()
      const finishCheck = deferred()
      const openStarted = deferred()
      const finishOpen = deferred()
      isOpen.mockImplementationOnce(async () => { checkStarted.resolve(); await finishCheck.promise; return true })
      const rejected = expect(sendOriginalVSCode(store, identity, crypto.randomUUID(), 'Do not send during opening')).rejects.toThrow('conversation is opening')
      await checkStarted.promise
      open.mockImplementationOnce(async () => { openStarted.resolve(); await finishOpen.promise; opened = true })
      const opening = openOriginalVSCode(store, identity)
      try {
        await openStarted.promise
        finishCheck.resolve()
        await rejected
        expect(dispatch).toHaveBeenCalledOnce()
      } finally { finishCheck.resolve(); finishOpen.resolve(); await opening }
      expect((await readOriginalVSCode(store, identity)).deliveries).toHaveLength(1)
    } finally { await bridge.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('authenticates an exact-workspace open and never exposes send, new, import, or arbitrary commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskcontinuum-vscode-bridge-'))
    const workspaceStorageId = 'a'.repeat(32)
    const directory = join(root, workspaceStorageId, 'chatSessions')
    await mkdir(directory, { recursive: true })
    const source = JSON.stringify({ kind: 0, v: { requests: [{ message: 'Original question', response: [{ value: 'Original answer' }] }] } }) + '\n'
    const file = join(directory, 'existing.jsonl')
    await writeFile(file, source)
    const open = vi.fn(async () => {})
    const discoveryDirectory = join(root, workspaceStorageId, 'taskcontinuum.vscode-bridge', 'bridges')
    const bridge = await startVSCodeChatCompanion({ storageRoot: root, workspaceStorageId, discoveryDirectory, vscodeVersion: '1.136.1', open })
    try {
      const base = `http://127.0.0.1:${bridge.descriptor.port}`
      const headers = { Authorization: `Bearer ${bridge.descriptor.token}`, 'Content-Type': 'application/json' }
      const identity = { nativeSessionId: 'existing', workspaceStorageId }
      const view = await readOriginalVSCode(new VSCodeSessionStore([root]), identity)
      expect(view).toMatchObject({ canSend: false, connectionState: 'unsupported' })
      expect(view.bridgeError).toContain('does not support sending')
      expect((await fetch(`${base}/identity`)).status).toBe(401)
      expect((await fetch(`${base}/identity`, { headers: { ...headers, Origin: 'https://example.invalid' } })).status).toBe(403)
      expect(await (await fetch(`${base}/identity`, { headers })).json()).toMatchObject({ workspaceStorageId, participant: { username: userInfo().username, machineName: hostname() }, execution: { agentName: 'GitHub Copilot', machineName: hostname() }, capabilities: { open: true, send: false } })
      const invoke = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
      expect((await invoke('/open', { ...identity, workspaceStorageId: 'b'.repeat(32) })).status).toBe(403)
      expect((await invoke('/open', { ...identity, nativeSessionId: '../existing' })).status).toBe(400)
      expect((await invoke('/open', { ...identity, nativeSessionId: 'missing' })).status).toBe(400)
      expect((await invoke('/open', { ...identity, command: 'workbench.action.chat.newChat' })).status).toBe(400)
      expect((await invoke('/send', identity)).status).toBe(404)
      expect(open).not.toHaveBeenCalled()
      expect(await (await invoke('/open', identity)).json()).toEqual({ opened: true, ...identity })
      expect(open).toHaveBeenCalledExactlyOnceWith(vsCodeChatResource('existing'))
      open.mockClear()
      await openOriginalVSCode(new VSCodeSessionStore([root]), identity)
      expect(open).toHaveBeenCalledExactlyOnceWith(vsCodeChatResource('existing'))
      await expect(openOriginalVSCode(new VSCodeSessionStore([root]), { ...identity, nativeSessionId: 'missing' })).rejects.toThrow('no new session was created')
      expect(await readFile(file, 'utf8')).toBe(source)
      expect(await readdir(directory)).toEqual(['existing.jsonl'])
    } finally { await bridge.close(); expect(await readdir(discoveryDirectory)).toEqual([]); await rm(root, { recursive: true, force: true }) }
  })

  it('accepts attributed messages only through the authenticated same-workspace send capability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskcontinuum-vscode-send-'))
    const workspaceStorageId = 'a'.repeat(32)
    const directory = join(root, workspaceStorageId, 'chatSessions')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'existing.json'), JSON.stringify({ inputState: { mode: { id: 'agent', kind: 'agent' } }, requests: [{ message: 'Original', result: {} }] }))
    const dispatch = vi.fn(async () => ({ state: 'submitted' as const, nativeRequestId: 'original-new-request' }))
    const discoveryDirectory = join(root, workspaceStorageId, 'taskcontinuum.vscode-bridge', 'bridges')
    const bridge = await startVSCodeChatCompanion({ storageRoot: root, workspaceStorageId, discoveryDirectory, vscodeVersion: '1.136.1', open: async () => {}, dispatch })
    try {
      const base = `http://127.0.0.1:${bridge.descriptor.port}`
      const headers = { Authorization: `Bearer ${bridge.descriptor.token}`, 'Content-Type': 'application/json' }
      const identity = { nativeSessionId: 'existing', workspaceStorageId }
      const message = { ...identity, id: crypto.randomUUID(), text: 'Continue my original conversation' }
      const invoke = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
      expect((await invoke('/send', { ...message, username: 'Someone else' })).status).toBe(400)
      expect((await invoke('/send', { ...message, workspaceStorageId: 'b'.repeat(32) })).status).toBe(403)
      expect(await (await invoke('/send', message)).json()).toMatchObject({ state: 'pending', participant: { username: userInfo().username }, execution: { machineName: hostname() } })
      await vi.waitFor(async () => expect(await (await invoke('/deliveries', identity)).json()).toMatchObject([{ state: 'submitted', nativeRequestId: 'original-new-request' }]))
      await invoke('/send', message)
      expect(dispatch).toHaveBeenCalledTimes(1)
      const store = new VSCodeSessionStore([root])
      const view = await readOriginalVSCode(store, identity)
      expect(view).toMatchObject({ canSend: true, connectionState: 'connected', participant: { username: userInfo().username }, execution: { machineName: hostname() } })
      const receipt = await sendOriginalVSCode(store, identity, crypto.randomUUID(), 'Another attributed message')
      expect(receipt).toMatchObject({ state: 'pending', participant: { username: userInfo().username } })
      await vi.waitFor(async () => expect((await readOriginalVSCode(store, identity)).deliveries?.at(-1)?.state).toBe('submitted'))
    } finally { await bridge.close(); await rm(root, { recursive: true, force: true }) }
  })

  it.each(['Code', 'Code - Insiders'])('offers a restricted connection for an existing offline %s conversation', async (brand) => {
    const root = await mkdtemp(join(tmpdir(), 'taskcontinuum-vscode-connect-'))
    const storageRoot = join(root, brand, 'User', 'workspaceStorage')
    const identity = { nativeSessionId: 'existing', workspaceStorageId: 'a'.repeat(32) }
    const directory = join(storageRoot, identity.workspaceStorageId, 'chatSessions')
    await mkdir(directory, { recursive: true })
    const source = JSON.stringify({ inputState: { inputText: 'Unsent original draft' }, requests: [{ message: 'Original', result: {} }] })
    const file = join(directory, 'existing.json')
    await writeFile(file, source)
    try {
      const store = new VSCodeSessionStore([storageRoot])
      const view = await readOriginalVSCode(store, identity)
      expect(view).toMatchObject({ canSend: false, connectionState: 'offline' })
      expect(view.bridgeError).toContain('not connected')
      const openExternal = vi.fn(async () => {})
      await connectOriginalVSCode(store, identity, openExternal)
      expect(openExternal).toHaveBeenCalledExactlyOnceWith(vsCodeBridgeConnectUri(identity, brand === 'Code' ? 'vscode' : 'vscode-insiders'))
      await expect(connectOriginalVSCode(store, { ...identity, nativeSessionId: 'missing' }, openExternal)).rejects.toThrow('no new session was created')
      expect(openExternal).toHaveBeenCalledTimes(1)
      expect(await readFile(file, 'utf8')).toBe(source)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('reports a busy original Agent without treating it as a disconnected bridge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskcontinuum-vscode-busy-'))
    const identity = { nativeSessionId: 'existing', workspaceStorageId: 'a'.repeat(32) }
    const directory = join(root, identity.workspaceStorageId, 'chatSessions')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'existing.json'), JSON.stringify({ inputState: { mode: { id: 'agent', kind: 'agent' } }, requests: [{ message: 'Still working' }] }))
    const bridge = await startVSCodeChatCompanion({ storageRoot: root, workspaceStorageId: identity.workspaceStorageId, discoveryDirectory: join(root, identity.workspaceStorageId, 'taskcontinuum.vscode-bridge', 'bridges'), vscodeVersion: '1.136.1', open: async () => {}, dispatch: async () => ({ state: 'failed', error: 'Test must not dispatch.' }) })
    try {
      const view = await readOriginalVSCode(new VSCodeSessionStore([root]), identity)
      expect(view).toMatchObject({ canSend: false, responding: true, connectionState: 'connected' })
      expect(view.bridgeError).toContain('still responding')
    } finally { await bridge.close(); await rm(root, { recursive: true, force: true }) }
  })
})