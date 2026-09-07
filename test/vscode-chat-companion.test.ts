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