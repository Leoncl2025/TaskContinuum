import { setTimeout as delay } from 'node:timers/promises'

export const widgetProbeId = 'taskcontinuum-widget-presence'
export const sessionNotOpenMessage = 'The linked original conversation is not open in VS Code. Its view is no longer ready for this submission. No message was sent.'

export interface VSCodeWidgetCommands {
  probe(resource: string, id: string): Promise<{ success: boolean; error?: string } | undefined>
  open(resource: string): Promise<void>
}

export async function isVSCodeWidgetOpen(resource: string, probe: VSCodeWidgetCommands['probe']): Promise<boolean> {
  const result = await probe(resource, widgetProbeId)
  if (result?.success === false) {
    if (result.error === 'No chat widget found. Provide sessionResource or focus a chat widget.') return false
    if (result.error?.startsWith('No handoffs available for mode \'')) return true
    if (result.error?.startsWith(`No handoff with identifier '${widgetProbeId}' found for mode '`)) return true
  }
  throw new Error('The original-session view could not be verified with this VS Code build. No fallback operation was attempted.')
}

export async function openVerifiedVSCodeWidget(resource: string, commands: VSCodeWidgetCommands, signal: AbortSignal, timeout = 10000): Promise<void> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeout)])
  let cancel: (() => void) | undefined
  const opened = (async () => {
    deadline.throwIfAborted()
    await commands.open(resource)
    while (true) {
      deadline.throwIfAborted()
      if (await isVSCodeWidgetOpen(resource, commands.probe)) { deadline.throwIfAborted(); return }
      await delay(100, undefined, { signal: deadline })
    }
  })()
  try {
    await Promise.race([opened, new Promise<never>((_resolve, reject) => {
      cancel = () => reject(signal.aborted ? signal.reason : new Error('VS Code did not open the requested original conversation before the deadline. No message was sent; inspect the original workspace.'))
      deadline.addEventListener('abort', cancel, { once: true })
      if (deadline.aborted) cancel()
    })])
  } finally { if (cancel) deadline.removeEventListener('abort', cancel) }
}