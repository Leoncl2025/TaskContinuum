import { useEffect, useRef, useState } from 'react'
import type { SharedConnectionSummary, SharedDesktopUpdate, SharedView } from '../../shared/sharedSessions'

export function useSharedSessions(root: string) {
  const bridge = window.sharedSessions
  const [sessions, setSessions] = useState<SharedConnectionSummary[]>([])
  const [views, setViews] = useState<Record<string, SharedView>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = useRef(false)
  const mounted = useRef(false)
  const opened = useRef(new Set<string>())

  useEffect(() => {
    mounted.current = true
    const connections = opened.current
    const listener = (update: SharedDesktopUpdate) => {
      setViews((current) => {
        const previous = current[update.sessionId]
        if (!previous) return current
        const events = update.event ? [...previous.events.filter((event) => event.seq !== update.event!.seq), update.event].sort((left, right) => left.seq - right.seq) : previous.events
        return { ...current, [update.sessionId]: { ...previous, events, online: update.online ?? previous.online, error: update.online === true ? undefined : update.error ?? previous.error, lastSyncedAt: update.lastSyncedAt ?? previous.lastSyncedAt } }
      })
    }
    const unsubscribe = bridge?.onUpdate(listener)
    if (bridge) void bridge.list(root).then((value) => { if (mounted.current) setSessions(value) }).catch((failure: unknown) => { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Shared sessions could not be loaded.') })
    return () => {
      mounted.current = false
      unsubscribe?.()
      for (const id of connections) void bridge?.disconnect(id).catch(() => undefined)
    }
  }, [bridge, root])

  async function run<Result>(action: () => Promise<Result>): Promise<Result | undefined> {
    if (active.current) return undefined
    active.current = true
    setBusy(true)
    setError(null)
    try { return await action() } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'The shared-session operation failed.')
      return undefined
    } finally { active.current = false; if (mounted.current) setBusy(false) }
  }

  function retain(view: SharedView): void {
    opened.current.add(view.session.id)
    if (mounted.current) setViews((current) => {
      const previous = current[view.session.id]
      const events = [...new Map([...view.events, ...(previous?.events ?? [])].map((event) => [event.seq, event])).values()].sort((left, right) => left.seq - right.seq)
      return { ...current, [view.session.id]: { ...view, events } }
    })
  }
  async function refresh(): Promise<void> {
    if (bridge) { const value = await bridge.list(root); if (mounted.current) setSessions(value) }
  }
  async function open(id: string): Promise<void> {
    if (bridge) await run(async () => { retain(await bridge.cached(id)); retain(await bridge.open(id)) })
  }
  return { bridge, sessions, views, busy, error, setError, run, retain, refresh, open }
}