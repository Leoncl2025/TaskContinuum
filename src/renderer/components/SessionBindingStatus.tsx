import { useRef, useState } from 'react'
import { agentHostKey } from '../../shared/agentHost'
import type { SessionBindingIssue } from '../../shared/sessionBindings'
import { machineLabel, useMachineAliases, useWorkspaceGitSync } from '../machineAliases'
import { Icon } from './Primitives'

export function SessionBindingStatus({ taskId, issue, cachedTitles, busy = false, onRetry, onCancel, onReview, onDevices }: {
  taskId: string
  issue: SessionBindingIssue
  cachedTitles?: Readonly<Record<string, string>>
  busy?: boolean
  onRetry(): Promise<void>
  onCancel?(): Promise<void>
  onReview?(): void
  onDevices(): void
}) {
  const aliases = useMachineAliases()
  const { status, error: statusError, refresh } = useWorkspaceGitSync()
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string>()
  const running = useRef(false)
  const waiting = issue.state === 'awaiting-sync'
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy || running.current) return
    running.current = true
    setWorking(true)
    setError(undefined)
    try { await action() }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The pending binding could not be reviewed. Retry synchronization or inspect the publishing device.') }
    finally { await refresh(); running.current = false; setWorking(false) }
  }
  return <section className="session-binding-status" aria-label={`Session link status for ${taskId}`} aria-busy={working}>
    <h3><Icon name={waiting ? 'sync' : 'warning'} />{waiting ? 'Session links waiting for sync' : issue.state === 'conflict' ? 'Session links need conflict resolution' : 'Session links are blocked'}</h3>
    <p role={waiting ? 'status' : 'alert'}>Access is paused, not unlinked. {issue.savedRecordCount === undefined ? 'Saved binding records were not reset.' : `${issue.savedRecordCount} saved binding record(s) are retained.`} No original chats are deleted by this state.</p>
    {issue.reasons.map((reason, index) => <p key={`${reason.code}:${reason.operationId ?? index}`}>{reason.message}</p>)}
    {!!issue.pendingOperationIds.length && <details><summary>Pending operation details</summary>
      {issue.pendingOperationIds.map((id) => <code key={id}>{id}</code>)}
      <p>Receiving devices do not put another device's SSH hint in their publication outbox. The publishing device must synchronize the original signed operation.</p>
    </details>}
    {(error || statusError || status?.syncError) && <p className="copilot-error" role="alert">{error ?? statusError ?? status?.syncError}</p>}
    {status && !status.enabled && <p role="status">Automatic workspace synchronization is paused. Review the device settings before retrying.</p>}
    <div className="session-sidebar-actions">
      <button type="button" className="secondary-button" disabled={busy || working} onClick={() => { void run(onRetry) }}><Icon name="sync" />{working ? 'Working...' : 'Retry sync'}</button>
      {onReview && <button type="button" className="secondary-button" onClick={onReview}>Review saved associations</button>}
      <button type="button" className="text-button" onClick={onDevices}>Review sync and devices</button>
    </div>
    {!onReview && !!issue.savedBindings.length && <ul className="session-retained" aria-label={`Saved associations for ${taskId}`}>
      {issue.savedBindings.map((binding) => <li key={agentHostKey(binding)} aria-disabled="true">
        <strong>{cachedTitles?.[agentHostKey(binding)] ?? binding.sessionId}</strong>
        <span title={binding.owner.machineName}>{machineLabel(binding.owner, aliases)}</span>
        <span className="muted">Saved association - access paused</span>
      </li>)}
    </ul>}
    {onCancel && !!issue.pendingOperationIds.length && <details className="session-binding-recovery"><summary>Recovery options</summary>
      <p>If the publishing device cannot deliver this change, review the saved associations first. Cancelling removes only this device's pending markers, not signed records or chats. A later arrival can still change or conflict with the associations. No session will open automatically.</p>
      <button type="button" className="secondary-button" disabled={busy || working} onClick={() => { void run(onCancel) }}>Review cancellation of temporary change</button>
    </details>}
  </section>
}
