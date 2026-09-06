import { useEffect, useRef, useState } from 'react'
import type { CopilotEvent, CopilotStatus, SessionListing } from '../../shared/sessions'
import { createCopilotAdapter } from './copilotAdapter'

export type CopilotInteraction = Extract<CopilotEvent, { type: 'permission' | 'user-input' }>

function savedLiveMode(): boolean {
  try { return localStorage.getItem('taskcontinuum:copilot-mode') === 'live' } catch { return false }
}

export function useCopilotConnection() {
  const bridge = window.copilot
  const [adapter] = useState(() => bridge ? createCopilotAdapter(bridge) : undefined)
  const [enabled, setEnabled] = useState(() => Boolean(bridge) && savedLiveMode())
  const [status, setStatus] = useState<CopilotStatus>({ state: 'disconnected', workingDirectory: '' })
  const [listing, setListing] = useState<SessionListing>()
  const [models, setModels] = useState<{ id: string; name: string }[]>([])
  const [interactions, setInteractions] = useState<CopilotInteraction[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    const unsubscribe = bridge?.onEvent((event) => {
      if (event.type === 'permission' || event.type === 'user-input') setInteractions((current) => [...current, event])
      else if (event.type === 'interaction-resolved') setInteractions((current) => current.filter((item) => item.id !== event.id))
    })
    void bridge?.getStatus().then((value) => {
      if (mounted.current) { setStatus(value); if (value.state === 'ready') setEnabled(true) }
    }).catch((failure: unknown) => { if (mounted.current) setError(failure instanceof Error ? failure.message : 'The desktop bridge is unavailable.') })
    return () => { mounted.current = false; unsubscribe?.() }
  }, [bridge])

  useEffect(() => {
    if (bridge) { try { localStorage.setItem('taskcontinuum:copilot-mode', enabled ? 'live' : 'demo') } catch { return } }
  }, [bridge, enabled])

  async function run<Value>(label: string, action: () => Promise<Value>): Promise<Value | undefined> {
    if (inFlight.current) return undefined
    inFlight.current = true
    setBusy(label)
    setError(null)
    try { return await action() } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'The local Copilot operation failed.')
      return undefined
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(null)
    }
  }

  async function refresh(): Promise<void> {
    if (!bridge) return
    await run('Loading sessions', async () => { const value = await bridge.listSessions(); if (mounted.current) setListing(value) })
  }

  async function connect(): Promise<void> {
    if (!bridge) return
    setEnabled(true)
    await run('Connecting Copilot', async () => {
      const value = await bridge.connect()
      if (!mounted.current) return
      setStatus(value)
      if (value.state !== 'ready') { setError(value.error ?? 'Copilot is not ready.'); return }
      const sessions = await bridge.listSessions()
      if (mounted.current) setListing(sessions)
      const availableModels = await bridge.listModels()
      if (mounted.current) setModels(availableModels)
    })
  }

  async function disconnect(): Promise<void> {
    if (!bridge) return
    await run('Disconnecting Copilot', async () => {
      await bridge.disconnect()
      if (mounted.current) { setStatus((current) => ({ ...current, state: 'disconnected' })); setInteractions([]) }
    })
  }

  async function respond(id: string, value: boolean | string): Promise<void> {
    if (bridge) await run('Sending decision', () => bridge.respond(id, value))
  }

  return { bridge, adapter, enabled, status, listing, models, interactions, busy, error, setError, run, refresh, connect, disconnect, respond }
}