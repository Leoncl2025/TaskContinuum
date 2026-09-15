// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REMOTE_SYNC_INTERVAL_MS, RemoteSyncScheduler } from '../src/main/remoteConfig/scheduler'
import type { RemoteSyncStatus } from '../src/main/remoteConfig/scheduler'

const schedulers: RemoteSyncScheduler[] = []
afterEach(async () => {
  await Promise.all(schedulers.splice(0).map((scheduler) => scheduler.stop()))
  vi.useRealTimers()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('fixed remote configuration synchronization scheduler', () => {
  it('runs on open, at exactly 15/30/45 seconds, and immediately on edits without shifting the clock', async () => {
    vi.useFakeTimers()
    const cycle = vi.fn(async () => undefined)
    const scheduler = new RemoteSyncScheduler({ cycle })
    schedulers.push(scheduler)
    expect(REMOTE_SYNC_INTERVAL_MS).toBe(15000)
    scheduler.start()
    scheduler.start()
    await scheduler.whenIdle()
    expect(cycle).toHaveBeenCalledTimes(1)
    expect(cycle.mock.calls[0]).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2000)
    scheduler.request('binding')
    await scheduler.whenIdle()
    expect(cycle).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(12999)
    expect(cycle).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(cycle).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(15000)
    expect(cycle).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(15000)
    expect(cycle).toHaveBeenCalledTimes(5)
  })

  it('coalesces ticks and multiple edits during a slow cycle into a serialized follow-up', async () => {
    vi.useFakeTimers()
    const gate = deferred()
    let running = 0
    let maximum = 0
    const calls: string[][] = []
    const cycle = vi.fn(async ({ reasons }: { reasons: readonly string[] }) => {
      calls.push([...reasons])
      running++
      maximum = Math.max(maximum, running)
      if (calls.length === 1) await gate.promise
      running--
    })
    const scheduler = new RemoteSyncScheduler({ cycle })
    schedulers.push(scheduler)
    scheduler.start()
    await Promise.resolve()
    scheduler.request('binding')
    scheduler.request('invitation')
    scheduler.request('binding')
    for (let index = 0; index < 1000; index++) scheduler.request(`notification-${index}`)
    await vi.advanceTimersByTimeAsync(45000)
    expect(cycle).toHaveBeenCalledTimes(1)
    gate.resolve()
    await scheduler.whenIdle()
    expect(cycle).toHaveBeenCalledTimes(2)
    expect(calls[1]).toEqual(expect.arrayContaining(['binding', 'invitation', 'coalesced']))
    expect(calls[1].filter((reason) => reason === 'binding')).toHaveLength(1)
    expect(calls[1].length).toBeLessThanOrEqual(32)
    expect(maximum).toBe(1)
  })

  it('reports errors without busy retries and keeps the fixed next tick', async () => {
    vi.useFakeTimers()
    const events: RemoteSyncStatus[] = []
    const cycle = vi.fn(async () => { throw new Error('Offline; pending records retained.') })
    const scheduler = new RemoteSyncScheduler({ cycle, onStatus: (status) => events.push(status) })
    schedulers.push(scheduler)
    scheduler.start()
    await scheduler.whenIdle()
    expect(events.at(-1)).toMatchObject({ state: 'error', error: 'Offline; pending records retained.' })
    await vi.advanceTimersByTimeAsync(14999)
    expect(cycle).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(cycle).toHaveBeenCalledTimes(2)
    expect(events.filter((event) => event.state === 'error')).toHaveLength(2)
  })

  it('aborts and awaits active work, discards queued ticks, and can restart after stopping', async () => {
    vi.useFakeTimers()
    const gate = deferred()
    let observedSignal: AbortSignal | undefined
    const cycle = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      observedSignal = signal
      if (cycle.mock.calls.length === 1) await gate.promise
    })
    const scheduler = new RemoteSyncScheduler({ cycle })
    schedulers.push(scheduler)
    scheduler.start()
    await Promise.resolve()
    scheduler.request('pending')
    let stopped = false
    const stopping = scheduler.stop().then(() => { stopped = true })
    expect(observedSignal?.aborted).toBe(true)
    await Promise.resolve()
    expect(stopped).toBe(false)
    gate.resolve()
    await stopping
    scheduler.request('ignored')
    await vi.advanceTimersByTimeAsync(60000)
    expect(cycle).toHaveBeenCalledTimes(1)
    scheduler.start()
    await scheduler.whenIdle()
    expect(cycle).toHaveBeenCalledTimes(2)
  })

  it('keeps observer reentrancy and exceptions outside the worker serialization boundary', async () => {
    const cycle = vi.fn(async () => undefined)
    let notified = false
    const scheduler = new RemoteSyncScheduler({
      cycle,
      onStatus: (status) => {
        if (status.state === 'running' && !notified) {
          notified = true
          scheduler.request('reciprocal-grant')
        }
        if (status.state === 'idle') throw new Error('A broken observer')
      },
    })
    schedulers.push(scheduler)
    scheduler.request('not-enabled')
    expect(cycle).not.toHaveBeenCalled()
    scheduler.start()
    await scheduler.whenIdle()
    expect(cycle).toHaveBeenCalledTimes(2)
  })
})
