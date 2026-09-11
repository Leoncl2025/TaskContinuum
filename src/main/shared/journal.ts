import { mkdir, open, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SharedEvent, SharedSessionDescriptor } from '../../shared/sharedSessions'
import { eventSchema } from './schemas'
import { ChatImageStore } from '../chatImageStore'

export class SharedJournal {
  readonly images: ChatImageStore
  private events: SharedEvent[] = []
  private tail = Promise.resolve()
  private bytes = 0
  private failure?: Error
  private readonly listeners = new Set<(event: SharedEvent) => void>()

  constructor(private readonly file: string, private readonly session: SharedSessionDescriptor) {
    this.images = new ChatImageStore(join(dirname(file), 'images'))
  }

  async load(): Promise<void> {
    let content: string
    try {
      if ((await stat(this.file)).size > 32 * 1024 * 1024) throw new Error('Session journal exceeds its 32 MB limit.')
      content = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const lines = content.split('\n')
    if (lines.at(-1) !== '') throw new Error('Session journal has an incomplete write. Preserve it and repair the final record before restarting.')
    const events = lines.filter(Boolean).map((line) => eventSchema.parse(JSON.parse(line)))
    for (const [index, event] of events.entries()) {
      if (event.seq !== index + 1 || event.sessionId !== this.session.id || event.epoch !== this.session.owner.epoch) throw new Error('Session journal identity or sequence mismatch.')
    }
    this.events = events
    this.bytes = Buffer.byteLength(content)
  }

  snapshot(after = 0): SharedEvent[] { return structuredClone(this.events.filter((event) => event.seq > after)) }
  get lastSeq(): number { return this.events.length }
  subscribe(listener: (event: SharedEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  append(data: Omit<SharedEvent, 'sessionId' | 'epoch' | 'seq' | 'at'>): Promise<SharedEvent> {
    return this.write(() => eventSchema.parse({ ...data, sessionId: this.session.id, epoch: this.session.owner.epoch, seq: this.events.length + 1, at: new Date().toISOString() }))
  }

  accept(value: SharedEvent): Promise<SharedEvent> {
    return this.write(() => {
      const event = eventSchema.parse(value)
      if (event.sessionId !== this.session.id || event.epoch !== this.session.owner.epoch) throw new Error('Received events from a different session owner.')
      if (event.seq <= this.events.length) {
        if (JSON.stringify(this.events[event.seq - 1]) !== JSON.stringify(event)) throw new Error('Received a conflicting event sequence.')
        return event
      }
      if (event.seq !== this.events.length + 1) throw new Error('Session event gap detected. Reconnect before continuing.')
      return event
    })
  }

  private write(create: () => SharedEvent): Promise<SharedEvent> {
    const write = async () => {
      if (this.failure) throw this.failure
      const event = create()
      if (event.seq <= this.events.length) return event
      const content = JSON.stringify(event) + '\n'
      const bytes = Buffer.byteLength(content)
      if (this.bytes + bytes > 32 * 1024 * 1024) throw new Error('Session journal is full. Create a checkpoint and continue in a new session.')
      await mkdir(dirname(this.file), { recursive: true })
      const handle = await open(this.file, 'a', 0o600)
      try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
      this.events.push(event)
      this.bytes += bytes
      for (const listener of this.listeners) { try { listener(structuredClone(event)) } catch { this.listeners.delete(listener) } }
      return event
    }
    const operation = this.tail.then(write)
    this.tail = operation.then(() => undefined, (error: unknown) => { this.failure = error instanceof Error ? error : new Error('Journal write failed.') })
    return operation
  }
}