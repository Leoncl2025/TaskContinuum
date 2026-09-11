import * as vscode from 'vscode'
import { basename, dirname, join } from 'node:path'
import { startVSCodeChatCompanion } from './vscodeChatCompanion'
import { dispatchVSCodeMessage, verifyVSCodeDeliveryTemplate } from './vscodeChatDispatch'
import type { VSCodeDeliveryMode } from './vscodeChatDispatch'
import { VSCodeSessionStore } from './vscodeSessions'
import { identityFromVSCodeBridgeUri } from '../shared/vscodeChat'
import { isVSCodeWidgetOpen, openVerifiedVSCodeWidget } from './vscodeChatWidget'

let companion: Awaited<ReturnType<typeof startVSCodeChatCompanion>> | undefined
let changing = false
let readiness: AbortController | undefined
let bridgeLifetime: AbortController | undefined
let shutdown: (() => void) | undefined

export function activate(context: vscode.ExtensionContext): void {
  let templateRevision = 0
  const autoStartKey = 'taskcontinuum.bridgeEnabled'
  let disposed = false
  let retry: ReturnType<typeof setTimeout> | undefined
  let retries = 0
  let lifecycle = 0
  shutdown = () => { disposed = true; clearTimeout(retry); readiness?.abort(new Error('The bridge is shutting down.')); bridgeLifetime?.abort(new Error('The bridge is shutting down.')) }
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 20)
  status.text = '$(link) Task Continuum'
  status.tooltip = 'Original-chat bridge is running. Tool approvals stay in VS Code.'
  status.command = 'taskcontinuum.stopBridge'
  context.subscriptions.push(status)
  function sourceStorage(): string {
    if (!/^1\.(136|137)\./.test(vscode.version)) throw new Error(`VS Code ${vscode.version} is not verified for original-chat delivery. This adapter supports 1.136.x and 1.137.x only.`)
    if (!vscode.workspace.isTrusted || vscode.env.remoteName || !vscode.workspace.workspaceFolders?.length || vscode.workspace.workspaceFolders.some((folder) => folder.uri.scheme !== 'file')) {
      throw new Error('Open the original local, trusted workspace before starting the bridge. Remote and virtual workspaces are not supported.')
    }
    if (context.storageUri?.scheme !== 'file') throw new Error('This window has no local workspace storage.')
    return dirname(context.storageUri.fsPath)
  }
  async function startBridge(automatic = false): Promise<void> {
    if (disposed || companion || changing) return
    clearTimeout(retry)
    changing = true
    const startedAt = lifecycle
    try {
      const workspaceStorage = sourceStorage()
      if (!automatic) { await context.workspaceState.update(autoStartKey, true); retries = 0 }
      if (disposed || lifecycle !== startedAt) return
      const openCommand = 'workbench.action.chat.openSessionInEditorGroup'
      const commands = await vscode.commands.getCommands(true)
      if (!commands.includes(openCommand)) throw new Error('The original-session open command is unavailable in this VS Code build.')
      await vscode.commands.executeCommand('setContext', 'taskcontinuum.deliveryRevision', templateRevision)
      const templatePath = join(context.extensionUri.fsPath, 'out', 'delivery.agent.md')
      const templateCommands = {
        modes: async () => await vscode.commands.executeCommand<VSCodeDeliveryMode[]>('workbench.action.chat.getHandoffs') ?? [],
        writeTemplate: async (content: string) => {
          await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(context.extensionUri, 'out', 'delivery.agent.md'), Buffer.from(content, 'utf8'))
          await vscode.commands.executeCommand('setContext', 'taskcontinuum.deliveryRevision', ++templateRevision)
        },
      }
      const canDispatch = commands.includes('workbench.action.chat.executeHandoff') && commands.includes('workbench.action.chat.getHandoffs')
      if (automatic && !canDispatch) throw new Error('Waiting for original-session delivery commands to become available.')
      if (canDispatch) {
        readiness = new AbortController()
        await verifyVSCodeDeliveryTemplate(templatePath, templateCommands, readiness.signal)
      }
      const store = new VSCodeSessionStore([dirname(workspaceStorage)])
      const lifetime = new AbortController()
      bridgeLifetime = lifetime
      const probeWidget = async (resource: string, id: string) => {
        lifetime.signal.throwIfAborted()
        if (!vscode.workspace.isTrusted) throw new Error('The workspace is no longer trusted.')
        return vscode.commands.executeCommand<{ success: boolean; error?: string }>('workbench.action.chat.executeHandoff', { sessionResource: resource, sourceCustomAgent: 'agent', id })
      }
      const isOpen = (resource: string) => isVSCodeWidgetOpen(resource, probeWidget)
      const openOriginal = async (resource: string) => {
        if (!vscode.workspace.isTrusted) throw new Error('The workspace is no longer trusted.')
        await openVerifiedVSCodeWidget(resource, { probe: probeWidget, open: async (target) => {
          lifetime.signal.throwIfAborted()
          if (!vscode.workspace.isTrusted) throw new Error('The workspace is no longer trusted.')
          await vscode.commands.executeCommand(openCommand, { resource: vscode.Uri.parse(target) })
        } }, lifetime.signal)
      }
      if (disposed || lifecycle !== startedAt) return
      companion = await startVSCodeChatCompanion({
        storageRoot: dirname(workspaceStorage), workspaceStorageId: basename(workspaceStorage),
        discoveryDirectory: join(workspaceStorage, context.extension.id, 'bridges'), vscodeVersion: vscode.version,
        open: openOriginal,
        isOpen: canDispatch ? isOpen : undefined,
        autoOpenOnSend: canDispatch,
        dispatch: canDispatch
          ? (identity, delivery, signal, imageFiles) => dispatchVSCodeMessage({ identity, delivery, signal, imageFiles, store, templatePath, commands: {
            ...templateCommands,
            isOpen,
            confirm: async (target, message, title) => {
              if (!vscode.workspace.isTrusted) return false
              if (vscode.workspace.getConfiguration('taskcontinuum').get<boolean>('confirmOriginalSessionSend', false) === false) return true
              const chosen = await vscode.window.showWarningMessage(`Send to original Copilot conversation "${title}"?`, {
                modal: true,
                detail: `From: ${message.participant.username} @ ${message.participant.machineName}\nAgent machine: ${message.execution.machineName}\nSession: ${target.nativeSessionId}\n\n${message.text}${message.images?.length ? `\n\nImages: ${message.images.map((image) => image.name).join(', ')}` : ''}\n\nThe original Agent mode is retained. Existing tool approvals still apply. An unsaved draft in this chat must be sent or cleared first.`,
              }, 'Send to original session')
              return chosen === 'Send to original session'
            },
            handoff: async (resource, sourceAgent, label) => {
              if (!vscode.workspace.isTrusted) throw new Error('The workspace is no longer trusted. No message was sent.')
              return vscode.commands.executeCommand('workbench.action.chat.executeHandoff', { sessionResource: resource, sourceCustomAgent: sourceAgent, label })
            },
          } }) : undefined,
      })
      if (disposed || lifecycle !== startedAt) { await companion.close(); companion = undefined; return }
      retries = 0
      status.show()
    } catch (error) {
      if (disposed || lifecycle !== startedAt) return
      if (automatic && context.workspaceState.get<boolean>(autoStartKey, false) && retries < 3) {
        retry = setTimeout(() => { void startBridge(true) }, 5000 * ++retries)
      } else {
        await vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Task Continuum bridge could not start.')
      }
    } finally { readiness = undefined; changing = false }
  }
  context.subscriptions.push(vscode.commands.registerCommand('taskcontinuum.startBridge', () => startBridge()))
  context.subscriptions.push(vscode.window.registerUriHandler({
    handleUri: async (uri) => {
      try {
        const workspaceStorage = sourceStorage()
        const identity = identityFromVSCodeBridgeUri(uri.toString(true), vscode.env.uriScheme, basename(workspaceStorage))
        const original = await new VSCodeSessionStore([dirname(workspaceStorage)]).locateOriginal(identity)
        if (companion) return
        if (context.workspaceState.get<boolean>(autoStartKey, false)) { await startBridge(true); return }
        const accepted = await vscode.window.showInformationMessage('Connect Task Continuum to this VS Code workspace?', {
          modal: true,
          detail: `Original conversation: ${original.snapshot.session.title}\nSession: ${identity.nativeSessionId}\n\nThis enables the authenticated local bridge and remembers this workspace for automatic reconnection after VS Code restarts. Stop VS Code Bridge disables automatic reconnection. No message is sent, no conversation is opened or created, and Copilot tool approvals are unchanged.`,
        }, 'Connect')
        if (accepted === 'Connect') await startBridge()
      } catch (error) {
        await vscode.window.showErrorMessage(error instanceof Error ? error.message : 'The desktop connection request was rejected.')
      }
    },
  }))
  context.subscriptions.push(vscode.commands.registerCommand('taskcontinuum.stopBridge', async () => {
    lifecycle++
    await context.workspaceState.update(autoStartKey, false)
    clearTimeout(retry)
    readiness?.abort(new Error('The bridge startup was stopped.'))
    bridgeLifetime?.abort(new Error('The bridge was stopped.'))
    if (changing) return
    changing = true
    try { await companion?.close(); companion = undefined; status.hide() } finally { changing = false }
  }))
  if (context.workspaceState.get<boolean>(autoStartKey, false)) {
    try { sourceStorage(); void startBridge(true) } catch { return }
  }
}

export async function deactivate(): Promise<void> {
  shutdown?.()
  readiness?.abort(new Error('The bridge stopped during its readiness check.'))
  bridgeLifetime?.abort(new Error('The bridge stopped while checking its original view.'))
  await companion?.close()
  companion = undefined
}