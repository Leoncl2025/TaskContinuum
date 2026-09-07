// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchVSCodeMessage, verifyVSCodeDeliveryTemplate } from '../src/main/vscodeChatDispatch'
import type { VSCodeDeliveryCommands } from '../src/main/vscodeChatDispatch'
import { deliveryPrompt } from '../src/main/vscodeChatDelivery'
import { VSCodeSessionStore } from '../src/main/vscodeSessions'
import { vsCodeChatResource } from '../src/shared/vscodeChat'
import type { VSCodeChatDelivery } from '../src/shared/vscodeChat'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'taskcontinuum-dispatch-'))
  directories.push(root)
  const identity = { nativeSessionId: 'original', workspaceStorageId: 'a'.repeat(32) }
  const folder = join(root, identity.workspaceStorageId, 'chatSessions')
  await mkdir(folder, { recursive: true })
  const file = join(folder, 'original.json')
  const data = { inputState: { mode: { id: 'custom-agent', kind: 'agent' }, inputText: '' }, requests: [{ requestId: 'old', message: 'Earlier', result: {} }] }
  await writeFile(file, JSON.stringify(data))
  const templatePath = join(root, 'delivery.agent.md')
  const empty = '---\nname: Empty delivery\nhandoffs: []\n---\n'
  await writeFile(templatePath, empty)
  const delivery: VSCodeChatDelivery = { id: randomUUID(), nativeSessionId: identity.nativeSessionId, text: 'Continue once', participant: { username: 'Alice', machineName: 'A' }, execution: { agentName: 'Copilot', machineName: 'B' }, createdAt: new Date().toISOString(), state: 'pending' }
  const commands = {
    modes: async () => {
      const content = await readFile(templatePath, 'utf8')
      return [{ id: 'custom-agent', name: 'Existing Agent', isBuiltin: false, handoffs: [] }, { id: pathToFileURL(templatePath).href, name: `Task Continuum Delivery ${delivery.id}`, isBuiltin: false, handoffs: content.includes(delivery.id) ? [{ label: `Task Continuum ${delivery.id}`, prompt: deliveryPrompt(delivery), agent: 'Existing Agent', send: true }] : [] }]
    },
    writeTemplate: vi.fn(async (content: string) => { await writeFile(templatePath, content, 'utf8') }),
    open: vi.fn(async () => {}), confirm: vi.fn(async () => true),
    handoff: vi.fn<VSCodeDeliveryCommands['handoff']>(async () => {
      await writeFile(file, JSON.stringify({ ...data, requests: [...data.requests, { requestId: 'accepted', message: deliveryPrompt(delivery), result: {} }] }))
      return { success: true, targetMode: 'Existing Agent' }
    }),
  }
  return { identity, delivery, templatePath, store: new VSCodeSessionStore([root]), signal: new AbortController().signal, commands, empty, file, data }
}

describe('exact-session VS Code dispatch', () => {
  it('checks a non-sending readiness handoff and restores the empty template without touching a conversation', async () => {
    const setup = await fixture()
    const source = await readFile(setup.file, 'utf8')
    const commands = {
      modes: async () => {
        const content = await readFile(setup.templatePath, 'utf8')
        const encoded = content.split('\n').find((line) => line.startsWith('handoffs: '))!.slice('handoffs: '.length)
        return [{ id: 'agent', name: 'Agent', isBuiltin: true, handoffs: [] }, { id: pathToFileURL(setup.templatePath).href, name: 'Task Continuum Delivery', isBuiltin: false, handoffs: JSON.parse(encoded) }]
      },
      writeTemplate: setup.commands.writeTemplate,
    }
    await verifyVSCodeDeliveryTemplate(setup.templatePath, commands, setup.signal)
    expect(commands.writeTemplate).toHaveBeenCalledTimes(2)
    expect(commands.writeTemplate.mock.calls[0][0]).toContain('"send":false')
    expect(commands.writeTemplate).toHaveBeenLastCalledWith(setup.empty)
    expect(setup.commands.handoff).not.toHaveBeenCalled()
    expect(setup.commands.open).not.toHaveBeenCalled()
    expect(await readFile(setup.file, 'utf8')).toBe(source)
  })

  it('rejects a stale readiness cache and releases its template without offering a sender', async () => {
    const setup = await fixture()
    const commands = { modes: async () => [{ id: 'agent', name: 'Agent', isBuiltin: true, handoffs: [] }, { id: pathToFileURL(setup.templatePath).href, name: 'Task Continuum Delivery', isBuiltin: false, handoffs: [] }], writeTemplate: setup.commands.writeTemplate }
    await expect(verifyVSCodeDeliveryTemplate(setup.templatePath, commands, setup.signal, 1)).rejects.toThrow('handoff is missing or stale')
    expect(await readFile(setup.templatePath, 'utf8')).toBe(setup.empty)
    await expect(readFile(`${setup.templatePath}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(setup.commands.handoff).not.toHaveBeenCalled()
  })

  it('targets the original URI and original custom Agent, confirms native acceptance, and clears the template', async () => {
    const setup = await fixture()
    expect(await dispatchVSCodeMessage(setup)).toEqual({ state: 'submitted', nativeRequestId: 'accepted' })
    expect(setup.commands.handoff).toHaveBeenCalledWith(vsCodeChatResource('original'), pathToFileURL(setup.templatePath).href, `Task Continuum ${setup.delivery.id}`)
    expect(setup.commands.open).not.toHaveBeenCalled()
    expect(setup.commands.writeTemplate).toHaveBeenCalledTimes(2)
    expect(setup.commands.writeTemplate).toHaveBeenLastCalledWith(setup.empty)
    expect(await readFile(setup.templatePath, 'utf8')).toBe(setup.empty)
  })

  it('does not open another widget or move the session when the original widget is unavailable', async () => {
    const setup = await fixture()
    const original = await readFile(setup.file, 'utf8')
    vi.mocked(setup.commands.handoff).mockResolvedValue({ success: false, error: 'No chat widget found. Provide sessionResource or focus a chat widget.' })
    expect(await dispatchVSCodeMessage(setup)).toMatchObject({ state: 'failed', error: expect.stringContaining('no conversation was moved or created') })
    expect(setup.commands.open).not.toHaveBeenCalled()
    expect(setup.commands.handoff).toHaveBeenCalledTimes(1)
    expect(await readFile(setup.file, 'utf8')).toBe(original)
    expect(await readFile(setup.templatePath, 'utf8')).toBe(setup.empty)
  })

  it('leaves the original conversation and layout untouched when the delivery template cannot load', async () => {
    const setup = await fixture()
    const original = await readFile(setup.file, 'utf8')
    const originalMode = (await setup.commands.modes())[0]
    setup.commands.modes = async () => [originalMode]
    expect(await dispatchVSCodeMessage({ ...setup, confirmationTimeout: 1 })).toMatchObject({ state: 'failed', error: expect.stringContaining('template file is not registered') })
    expect(setup.commands.open).not.toHaveBeenCalled()
    expect(setup.commands.handoff).not.toHaveBeenCalled()
    expect(await readFile(setup.file, 'utf8')).toBe(original)
    expect(await readFile(setup.templatePath, 'utf8')).toBe(setup.empty)
    await expect(readFile(`${setup.templatePath}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['handoff', 'handoff is missing or stale'],
    ['prompt', 'handoff text does not match'],
    ['agent', 'handoff Agent does not match'],
    ['send', 'handoff auto-send is disabled'],
  ])('reports a %s mismatch without dispatching or exposing the message', async (mismatch, reason) => {
    const setup = await fixture()
    const modes = setup.commands.modes
    setup.commands.modes = async () => (await modes()).map((mode) => mode.isBuiltin || mode.id === 'custom-agent' ? mode : {
      ...mode,
      handoffs: mismatch === 'handoff' ? [] : mode.handoffs.map((handoff) => ({ ...handoff,
        prompt: mismatch === 'prompt' ? 'Outdated text' : handoff.prompt,
        agent: mismatch === 'agent' ? 'Another Agent' : handoff.agent,
        send: mismatch === 'send' ? false : handoff.send,
      })),
    })
    const result = await dispatchVSCodeMessage({ ...setup, confirmationTimeout: 1 })
    expect(result).toMatchObject({ state: 'failed', error: expect.stringContaining(reason) })
    expect(result.error).not.toContain(setup.delivery.text)
    expect(setup.commands.handoff).not.toHaveBeenCalled()
    expect(setup.commands.open).not.toHaveBeenCalled()
    expect(await readFile(setup.templatePath, 'utf8')).toBe(setup.empty)
  })

  it('identifies an exact handoff by its file and contents when the provider retains its registered display name', async () => {
    const setup = await fixture()
    const modes = setup.commands.modes
    setup.commands.modes = async () => (await modes()).map((mode) => mode.id === 'custom-agent' ? mode : { ...mode, name: 'Task Continuum Delivery' })
    expect(await dispatchVSCodeMessage(setup)).toEqual({ state: 'submitted', nativeRequestId: 'accepted' })
    expect(setup.commands.handoff).toHaveBeenCalledWith(vsCodeChatResource('original'), pathToFileURL(setup.templatePath).href, `Task Continuum ${setup.delivery.id}`)
    expect(setup.commands.open).not.toHaveBeenCalled()
  })

  it('does not dispatch or replace drafts when the user cancels or the original mode changes', async () => {
    const setup = await fixture()
    vi.mocked(setup.commands.confirm).mockResolvedValueOnce(false)
    expect((await dispatchVSCodeMessage(setup)).state).toBe('failed')
    expect(setup.commands.handoff).not.toHaveBeenCalled()
    expect(setup.commands.writeTemplate).not.toHaveBeenCalled()
    await writeFile(setup.file, JSON.stringify({ ...setup.data, inputState: { mode: { id: 'ask', kind: 'ask' } } }))
    expect((await dispatchVSCodeMessage(setup)).error).toContain('No mode was changed')
    expect(setup.commands.handoff).not.toHaveBeenCalled()
  })

  it('waits for the notified template update and stops safely if writing fails', async () => {
    const setup = await fixture()
    const original = await readFile(setup.file, 'utf8')
    setup.commands.writeTemplate.mockRejectedValueOnce(new Error('Template update was rejected'))
    expect(await dispatchVSCodeMessage(setup)).toMatchObject({ state: 'failed', error: 'Template update was rejected' })
    expect(setup.commands.handoff).not.toHaveBeenCalled()
    expect(setup.commands.writeTemplate).toHaveBeenLastCalledWith(setup.empty)
    expect(await readFile(setup.file, 'utf8')).toBe(original)
    await expect(readFile(`${setup.templatePath}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects ambiguous original Agent names before asking for confirmation', async () => {
    const setup = await fixture()
    const modes = await setup.commands.modes()
    setup.commands.modes = async () => [...modes, { id: 'other-agent', name: 'Existing Agent', isBuiltin: false, handoffs: [] }]
    expect((await dispatchVSCodeMessage(setup)).error).toContain('ambiguous')
    expect(setup.commands.confirm).not.toHaveBeenCalled()
    expect(setup.commands.handoff).not.toHaveBeenCalled()
  })

  it('stops waiting for confirmation when the bridge closes and never dispatches a late answer', async () => {
    const setup = await fixture()
    let finish!: (answer: boolean) => void
    const controller = new AbortController()
    vi.mocked(setup.commands.confirm).mockImplementation(() => new Promise<boolean>((accept) => { finish = accept }))
    const operation = dispatchVSCodeMessage({ ...setup, signal: controller.signal })
    await vi.waitFor(() => expect(setup.commands.confirm).toHaveBeenCalledOnce())
    controller.abort(new Error('Bridge stopped'))
    expect(await operation).toMatchObject({ state: 'failed', error: 'Bridge stopped' })
    finish(true)
    await Promise.resolve()
    expect(setup.commands.handoff).not.toHaveBeenCalled()
    expect(await readFile(setup.templatePath, 'utf8')).toBe(setup.empty)
  })
})