export type GatewayLane = 'control' | 'interactive' | 'history' | 'execution'

export const GATEWAY_LIMITS = {
  perSocket: { control: 2, interactive: 2, history: 1, execution: 1 },
  global: { control: 16, interactive: 16, history: 4, execution: 8 },
  activeTerminalsPerSocket: 1,
  activeTerminalsGlobal: 8,
  pendingPerSocket: 32,
  pendingGlobal: 128,
  bytesPerSocket: 16 * 1024 * 1024,
  bytesGlobal: 32 * 1024 * 1024,
  queueWaitMs: 10_000,
} as const

interface Request {
  owner: object
  lane: GatewayLane
  activeTerminal?: boolean
  bytes: number
  run(queueMs: number): Promise<void>
  drop(expired: boolean): void
  error(error: unknown): void
}

interface QueuedRequest extends Request {
  received: number
  timer?: ReturnType<typeof setTimeout>
}

type Counts = Record<GatewayLane, number>

function counts(): Counts { return { control: 0, interactive: 0, history: 0, execution: 0 } }

export class AgentHostGatewayScheduler {
  private readonly queues: Record<GatewayLane, QueuedRequest[]> = { control: [], interactive: [], history: [], execution: [] }
  private readonly active = counts()
  private activeTerminals = 0
  private readonly owners = new Map<object, { active: Counts; activeTerminals: number; pending: number; bytes: number }>()
  private pending = 0
  private bytes = 0

  get pendingCount(): number { return this.pending }

  enqueue(request: Request): boolean {
    if (!Number.isSafeInteger(request.bytes) || request.bytes < 0) throw new Error('Invalid gateway request size.')
    const owner = this.owners.get(request.owner) ?? { active: counts(), activeTerminals: 0, pending: 0, bytes: 0 }
    if (owner.pending >= GATEWAY_LIMITS.pendingPerSocket || this.pending >= GATEWAY_LIMITS.pendingGlobal
      || owner.bytes + request.bytes > GATEWAY_LIMITS.bytesPerSocket || this.bytes + request.bytes > GATEWAY_LIMITS.bytesGlobal) return false
    this.owners.set(request.owner, owner)
    owner.pending++
    owner.bytes += request.bytes
    this.pending++
    this.bytes += request.bytes
    const job: QueuedRequest = { ...request, received: performance.now() }
    this.queues[request.lane].push(job)
    this.drain(request.lane)
    if (this.queues[request.lane].includes(job)) {
      job.timer = setTimeout(() => {
        const index = this.queues[job.lane].indexOf(job)
        if (index < 0) return
        this.queues[job.lane].splice(index, 1)
        this.finish(job)
        job.drop(true)
        this.drain(job.lane)
      }, GATEWAY_LIMITS.queueWaitMs)
      job.timer.unref()
    }
    return true
  }

  cancel(owner: object): void {
    for (const lane of Object.keys(this.queues) as GatewayLane[]) {
      const queue = this.queues[lane]
      for (let index = queue.length - 1; index >= 0; index--) {
        if (queue[index].owner !== owner) continue
        const [job] = queue.splice(index, 1)
        clearTimeout(job.timer)
        this.finish(job)
        job.drop(false)
      }
      this.drain(lane)
    }
  }

  private finish(job: QueuedRequest): void {
    const owner = this.owners.get(job.owner)
    if (!owner) throw new Error('Gateway request accounting was lost.')
    owner.pending--
    owner.bytes -= job.bytes
    this.pending--
    this.bytes -= job.bytes
    if (!owner.pending) this.owners.delete(job.owner)
  }

  private drain(lane: GatewayLane): void {
    const queue = this.queues[lane]
    while (this.active[lane] < GATEWAY_LIMITS.global[lane]) {
      const index = queue.findIndex((job) => {
        const owner = this.owners.get(job.owner)
        return owner && owner.active[lane] < GATEWAY_LIMITS.perSocket[lane]
          && (!job.activeTerminal || owner.activeTerminals < GATEWAY_LIMITS.activeTerminalsPerSocket && this.activeTerminals < GATEWAY_LIMITS.activeTerminalsGlobal)
      })
      if (index < 0) break
      const [job] = queue.splice(index, 1)
      clearTimeout(job.timer)
      const owner = this.owners.get(job.owner)!
      this.active[lane]++
      owner.active[lane]++
      if (job.activeTerminal) { this.activeTerminals++; owner.activeTerminals++ }
      void job.run(performance.now() - job.received).catch((error: unknown) => job.error(error)).finally(() => {
        this.active[lane]--
        owner.active[lane]--
        if (job.activeTerminal) { this.activeTerminals--; owner.activeTerminals-- }
        this.finish(job)
        this.drain(lane)
      })
    }
  }
}
