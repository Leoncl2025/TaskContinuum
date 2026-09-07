import { open, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { vsCodeChatResource } from '../shared/vscodeChat'
import type { VSCodeChatDelivery, VSCodeChatIdentity } from '../shared/vscodeChat'
import { deliveryPrompt } from './vscodeChatDelivery'
import type { VSCodeDispatchResult } from './vscodeChatDelivery'
import type { VSCodeSessionStore } from './vscodeSessions'

export interface VSCodeDeliveryMode { id: string; name: string; isBuiltin: boolean; handoffs: { label: string; prompt: string; agent: string; send?: boolean }[] }
export interface VSCodeDeliveryCommands {
  modes(): Promise<VSCodeDeliveryMode[]>
  writeTemplate(content: string): Promise<void>
  confirm(identity: VSCodeChatIdentity, delivery: VSCodeChatDelivery, title: string): Promise<boolean>
  handoff(resource: string, sourceAgent: string, label: string): Promise<{ success: boolean; error?: string; targetMode?: string } | undefined>
}

function sameFile(uri: string, file: string): boolean {
  try {
    const actual = resolve(fileURLToPath(uri))
    return process.platform === 'win32' ? actual.toLowerCase() === resolve(file).toLowerCase() : actual === resolve(file)
  } catch { return false }
}

type TemplateCommands = Pick<VSCodeDeliveryCommands, 'modes' | 'writeTemplate'>
type TemplateHandoff = VSCodeDeliveryMode['handoffs'][number]

function templateContent(handoff: TemplateHandoff): string {
  return `---\nname: Task Continuum Delivery\ndescription: Deliver one confirmed message to the original conversation.\nhandoffs: ${JSON.stringify([handoff])}\n---\n\nThis is a delivery template, not the execution Agent.\n`
}

async function waitForTemplate(commands: TemplateCommands, templatePath: string, expected: TemplateHandoff, signal: AbortSignal, timeout: number): Promise<VSCodeDeliveryMode> {
  const deadline = Date.now() + timeout
  while (true) {
    signal.throwIfAborted()
    const available = await commands.modes()
    const templateModes = available.filter((mode) => sameFile(mode.id, templatePath))
    const source = templateModes.find((mode) => mode.handoffs.some((handoff) => handoff.label === expected.label && handoff.prompt === expected.prompt && handoff.agent === expected.agent && handoff.send === expected.send))
    if (source) return source
    if (Date.now() >= deadline) {
      const handoff = templateModes.flatMap((mode) => mode.handoffs).find((item) => item.label === expected.label)
      const reason = !templateModes.length ? 'template file is not registered'
        : !handoff ? 'handoff is missing or stale'
          : handoff.prompt !== expected.prompt ? 'handoff text does not match'
            : handoff.agent !== expected.agent ? 'handoff Agent does not match'
              : expected.send ? 'handoff auto-send is disabled' : 'readiness handoff must not send'
      throw new Error(`VS Code did not load the exact delivery template: ${reason}. No message was sent.`)
    }
    await delay(100, undefined, { signal })
  }
}

export async function verifyVSCodeDeliveryTemplate(templatePath: string, commands: TemplateCommands, signal: AbortSignal, timeout = 12000): Promise<void> {
  signal.throwIfAborted()
  const lockPath = `${templatePath}.lock`
  const lock = await open(lockPath, 'wx', 0o600)
  let previous: string | undefined
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, purpose: 'readiness' }))
    previous = await readFile(templatePath, 'utf8')
    const target = (await commands.modes()).find((mode) => mode.id === 'agent' && mode.isBuiltin)
    if (!target) throw new Error('Copilot Agent mode is unavailable. The delivery bridge was not started.')
    const probe: TemplateHandoff = { label: `Task Continuum readiness ${randomUUID()}`, agent: target.name, prompt: 'Local bridge readiness check. This is not a user message.', send: false }
    await commands.writeTemplate(templateContent(probe))
    await waitForTemplate(commands, templatePath, probe, signal, timeout)
  } finally {
    try { if (previous !== undefined) await commands.writeTemplate(previous) }
    finally { await lock.close(); await rm(lockPath, { force: true }) }
  }
}

async function awaitConfirmation(action: () => Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted()
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancel: (() => void) | undefined
  try {
    return await new Promise<boolean>((accept, reject) => {
      cancel = () => reject(signal.reason ?? new Error('The bridge stopped before sending was confirmed.'))
      signal.addEventListener('abort', cancel, { once: true })
      timer = setTimeout(() => accept(false), 5 * 60 * 1000)
      void Promise.resolve().then(action).then(accept, reject)
    })
  } finally {
    clearTimeout(timer)
    if (cancel) signal.removeEventListener('abort', cancel)
  }
}

export async function dispatchVSCodeMessage(options: {
  identity: VSCodeChatIdentity
  delivery: VSCodeChatDelivery
  signal: AbortSignal
  templatePath: string
  store: VSCodeSessionStore
  commands: VSCodeDeliveryCommands
  confirmationTimeout?: number
}): Promise<VSCodeDispatchResult> {
  const { identity, delivery, signal, templatePath, store, commands } = options
  let attempted = false
  let lock: Awaited<ReturnType<typeof open>> | undefined
  let emptyTemplate: string | undefined
  const lockPath = `${templatePath}.lock`
  try {
    signal.throwIfAborted()
    const original = await store.locateOriginal(identity)
    if (!original.state.mode || original.state.mode.kind !== 'agent') throw new Error('Select Agent mode in the original VS Code conversation before sending from Task Continuum. No mode was changed.')
    if (original.state.turns.at(-1)?.complete === false || original.state.hasDraft) throw new Error('The original conversation is busy or has a saved draft. Resolve it in VS Code before sending.')
    const modes = await commands.modes()
    const target = modes.find((mode) => mode.id === original.state.mode!.id)
    if (!target) throw new Error('The original Agent mode could not be identified. No message was sent.')
    if (sameFile(target.id, templatePath) || modes.filter((mode) => mode.name.toLowerCase() === target.name.toLowerCase()).length !== 1) throw new Error('The original Agent name is ambiguous. No message was sent.')
    if (!await awaitConfirmation(() => commands.confirm(identity, delivery, original.snapshot.session.title), signal)) return { state: 'failed', error: 'Sending was cancelled or its confirmation expired in VS Code. No message was sent.' }
    signal.throwIfAborted()
    const resource = vsCodeChatResource(identity.nativeSessionId)
    lock = await open(lockPath, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw new Error('Another VS Code window is delivering a message. No message was sent. Retry after it finishes.')
      throw error
    })
    await lock.writeFile(JSON.stringify({ pid: process.pid, commandId: delivery.id }))
    emptyTemplate = await readFile(templatePath, 'utf8')
    const label = `Task Continuum ${delivery.id}`
    const prompt = deliveryPrompt(delivery)
    const expected = { label, agent: target.name, prompt, send: true }
    await commands.writeTemplate(templateContent(expected))
    const sourceAgent = await waitForTemplate(commands, templatePath, expected, signal, options.confirmationTimeout ?? 12000)
    const latest = await store.locateOriginal(identity)
    if (latest.state.mode?.id !== original.state.mode.id || latest.state.turns.length !== original.state.turns.length || latest.state.turns.at(-1)?.complete === false || latest.state.hasDraft) throw new Error('The original conversation changed while preparing delivery. No message was sent.')
    const currentModes = (await commands.modes()).filter((mode) => mode.name.toLowerCase() === target.name.toLowerCase())
    if (currentModes.length !== 1 || currentModes[0].id !== target.id) throw new Error('The original Agent changed while preparing delivery. No message was sent.')
    signal.throwIfAborted()
    attempted = true
    const result = await commands.handoff(resource, sourceAgent.id, label)
    if (!result?.success) return { state: 'failed', error: result?.error?.startsWith('No chat widget found.')
      ? 'The linked original conversation is not open in VS Code. Open it there and retry. No message was sent and no conversation was moved or created.'
      : result?.error ?? 'VS Code rejected the original-session delivery.' }
    if (result.targetMode !== target.name) throw new Error('VS Code reported a different Agent mode. Inspect the original conversation before retrying.')
    const acceptedDeadline = Date.now() + (options.confirmationTimeout ?? 90000)
    while (true) {
      signal.throwIfAborted()
      const current = await store.locateOriginal(identity)
      const accepted = current.state.turns.slice(original.state.turns.length).find((turn) => turn.prompt === prompt && turn.id)
      if (accepted) return { state: 'submitted', nativeRequestId: accepted.id }
      if (Date.now() >= acceptedDeadline) return { state: 'uncertain', error: 'VS Code has not persisted the matching request yet. Check the original conversation; this message will not be resent automatically.' }
      await delay(150, undefined, { signal })
    }
  } catch (error) {
    return { state: attempted ? 'uncertain' : 'failed', error: error instanceof Error ? error.message.slice(0, 1500) : 'Original-session delivery failed.' }
  } finally {
    if (lock) {
      try { if (emptyTemplate !== undefined) await commands.writeTemplate(emptyTemplate) }
      finally { await lock.close(); await rm(lockPath, { force: true }) }
    }
  }
}