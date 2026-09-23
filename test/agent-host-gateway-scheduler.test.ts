// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { AgentHostGatewayScheduler, GATEWAY_LIMITS } from '../src/main/agentHostGatewayScheduler'

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

describe('Agent Host gateway scheduling', () => {
  it('reserves P0 for ping and P1 for models while history and active terminals are slow', async () => {
    const scheduler = new AgentHostGatewayScheduler()
    const owner = {}
    const blocked = deferred()
    const started: string[] = []
    const request = (name: string, lane: 'control' | 'interactive' | 'history', activeTerminal = false) => scheduler.enqueue({
      owner, lane, activeTerminal, bytes: 100,
      run: async () => { started.push(name); if (name.startsWith('terminal')) await blocked.promise },
      drop: vi.fn(), error: (error) => { throw error },
    })
    try {
      expect(request('terminal-active-1', 'interactive', true)).toBe(true)
      expect(request('terminal-active-2', 'interactive', true)).toBe(true)
      for (let index = 0; index < 16; index++) expect(request(`terminal-history-${index}`, 'history')).toBe(true)
      expect(request('models', 'interactive')).toBe(true)
      expect(request('ping', 'control')).toBe(true)
      await expect.poll(() => started).toContain('models')
      expect(started).toContain('ping')
      expect(started).toContain('terminal-active-1')
      expect(started).not.toContain('terminal-active-2')
      expect(started.filter((name) => name.startsWith('terminal-history'))).toHaveLength(1)
      expect(scheduler.pendingCount).toBe(18)
    } finally {
      scheduler.cancel(owner)
      blocked.release()
      await expect.poll(() => scheduler.pendingCount).toBe(0)
    }
  })

  it('preserves send/cancel order without holding P0', async () => {
    const scheduler = new AgentHostGatewayScheduler()
    const owner = {}
    const blocked = deferred()
    const order: string[] = []
    const operation = (name: string, lane: 'execution' | 'control') => scheduler.enqueue({
      owner, lane, bytes: 1, run: async () => {
        order.push(name)
        if (name === 'send') await blocked.promise
      }, drop: vi.fn(), error: (error) => { throw error },
    })
    expect(operation('send', 'execution')).toBe(true)
    expect(operation('cancel', 'execution')).toBe(true)
    expect(operation('ping', 'control')).toBe(true)
    await expect.poll(() => order).toEqual(['send', 'ping'])
    blocked.release()
    await expect.poll(() => order).toEqual(['send', 'ping', 'cancel'])
    await expect.poll(() => scheduler.pendingCount).toBe(0)
  })

  it('bounds concurrent history requests and total pending work across connections', async () => {
    const scheduler = new AgentHostGatewayScheduler()
    const owners = Array.from({ length: 5 }, () => ({}))
    const blocked = deferred()
    let running = 0
    let peak = 0
    try {
      for (const owner of owners.slice(0, 4)) for (let index = 0; index < GATEWAY_LIMITS.pendingPerSocket; index++) expect(scheduler.enqueue({
        owner, lane: 'history', bytes: 1, run: async () => { peak = Math.max(peak, ++running); await blocked.promise; running-- },
        drop: vi.fn(), error: (error) => { throw error },
      })).toBe(true)
      expect(scheduler.pendingCount).toBe(GATEWAY_LIMITS.pendingGlobal)
      expect(peak).toBe(GATEWAY_LIMITS.global.history)
      expect(scheduler.enqueue({ owner: owners[4], lane: 'history', bytes: 1, run: async () => {}, drop: vi.fn(), error: vi.fn() })).toBe(false)
    } finally {
      for (const owner of owners) scheduler.cancel(owner)
      blocked.release()
      await expect.poll(() => scheduler.pendingCount).toBe(0)
    }
  })

  it('expires a queued request before the client request timeout', async () => {
    vi.useFakeTimers()
    const scheduler = new AgentHostGatewayScheduler()
    const owner = {}
    const blocked = deferred()
    const dropped = vi.fn()
    try {
      expect(scheduler.enqueue({ owner, lane: 'history', bytes: 1, run: () => blocked.promise, drop: dropped, error: vi.fn() })).toBe(true)
      expect(scheduler.enqueue({ owner, lane: 'history', bytes: 1, run: vi.fn(async () => {}), drop: dropped, error: vi.fn() })).toBe(true)
      await vi.advanceTimersByTimeAsync(GATEWAY_LIMITS.queueWaitMs)
      expect(dropped).toHaveBeenCalledWith(true)
      expect(GATEWAY_LIMITS.queueWaitMs).toBeLessThan(15_000)
      expect(scheduler.pendingCount).toBe(1)
    } finally {
      scheduler.cancel(owner)
      blocked.release()
      await vi.runAllTimersAsync()
      vi.useRealTimers()
    }
    expect(scheduler.pendingCount).toBe(0)
  })
})
