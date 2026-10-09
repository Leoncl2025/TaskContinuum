import type { UpdateBridge } from '../shared/updates'

export function updateBlockers(document: Document): string[] {
  // Hidden Activity panes retain their DOM even when their effects are suspended.
  return [...new Set(Array.from(document.querySelectorAll<HTMLElement>('[data-update-blocker]'))
    .map((element) => element.dataset.updateBlocker).filter((reason): reason is string => Boolean(reason)))]
}

export function registerInstallSafety(bridge: Pick<UpdateBridge, 'onPrepareInstall' | 'respondToInstall' | 'onInstallAborted'>, document: Document, onError: (error: string) => void): () => void {
  let frozen = false
  let previousInert = false
  const dialogs = new Map<HTMLDialogElement, boolean>()
  const stopKeys = (event: KeyboardEvent) => { event.preventDefault(); event.stopImmediatePropagation() }
  const resume = () => {
    if (!frozen) return
    document.body.inert = previousInert
    for (const [dialog, inert] of dialogs) dialog.inert = inert
    dialogs.clear()
    document.removeEventListener('keydown', stopKeys, true)
    frozen = false
  }
  const prepare = bridge.onPrepareInstall((requestId) => {
    if (!frozen) {
      previousInert = document.body.inert
      document.body.inert = true
      // Modal dialogs escape ancestor inertness and must be frozen explicitly.
      for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) {
        dialogs.set(dialog, dialog.inert)
        dialog.inert = true
      }
      document.addEventListener('keydown', stopKeys, true)
      frozen = true
    }
    void bridge.respondToInstall(requestId, updateBlockers(document)).catch((error: unknown) => {
      resume()
      onError(error instanceof Error ? error.message : 'The update restart safety check failed. Nothing was installed.')
    })
  })
  const aborted = bridge.onInstallAborted(resume)
  return () => { prepare(); aborted(); resume() }
}
