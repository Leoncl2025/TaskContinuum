import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { access, mkdir, rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { z } from 'zod'
import { readJsonBounded, writeJsonAtomic } from '../shared/storage'
import type { RemoteSettings } from '../../shared/remoteConfig'
export type { RemoteSettings, RemoteSettingChanges } from '../../shared/remoteConfig'

export const remoteSettingsSchema = z.object({
  autoLink: z.boolean(),
  tunnelEnabled: z.boolean(),
  connectTimeoutMs: z.number().int().min(1000).max(120000),
}).strict()
const settingHeads = z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(256)
const frontierSchema = z.object({ autoLink: settingHeads, tunnelEnabled: settingHeads, connectTimeoutMs: settingHeads }).strict()
export type SettingsFrontier = z.infer<typeof frontierSchema>
const projectionSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  values: remoteSettingsSchema,
  frontier: frontierSchema.optional(),
}).strict()
type Projection = z.infer<typeof projectionSchema>
const exportSchema = z.object({ schemaVersion: z.literal(1), previous: projectionSchema.nullable(), next: projectionSchema }).strict()

export class LocalSettingsFile {
  private pending: Promise<unknown> = Promise.resolve()
  private watcher?: FSWatcher
  private timer?: ReturnType<typeof setTimeout>
  private closed = false

  constructor(readonly file: string, private readonly options: {
    read(): Promise<{ revision: string | null; values: RemoteSettings; frontier?: SettingsFrontier }>
    apply(revision: string | null, changes: Partial<RemoteSettings>, frontier?: SettingsFrontier): Promise<void>
    onError(error: unknown): void
  }) {}

  private queue(action: () => Promise<void>): Promise<void> {
    const work = this.pending.then(action)
    this.pending = work.then(() => undefined, () => undefined)
    return work
  }

  private async document(file: string): Promise<Projection | undefined> {
    try { return projectionSchema.parse(await readJsonBounded(file, 65536)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }

  private async recoverExport(): Promise<void> {
    const journalFile = `${this.file}.export`
    let journal: z.infer<typeof exportSchema>
    try { journal = exportSchema.parse(await readJsonBounded(journalFile, 256 * 1024)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    const current = await this.document(this.file)
    if (JSON.stringify(current ?? null) === JSON.stringify(journal.previous)) {
      await writeJsonAtomic(this.file, journal.next)
      await writeJsonAtomic(`${this.file}.baseline`, journal.next)
    } else if (JSON.stringify(current) === JSON.stringify(journal.next)) {
      await writeJsonAtomic(`${this.file}.baseline`, journal.next)
    } else if (current && journal.previous && current.revision === journal.previous.revision) {
      await writeJsonAtomic(`${this.file}.baseline`, journal.previous)
    } else if (current?.revision === journal.next.revision) {
      await writeJsonAtomic(`${this.file}.baseline`, journal.next)
    } else {
      throw new Error('The settings export was interrupted and its edited revision is unknown. The proposal was not overwritten.')
    }
    await rm(journalFile)
  }

  private async reconcile(): Promise<void> {
    const current = await this.document(this.file)
    const baseline = await this.document(`${this.file}.baseline`)
    if (current && !baseline) throw new Error('The editable settings file has no recorded base revision. It was not overwritten.')
    if (current && baseline && JSON.stringify(current) !== JSON.stringify(baseline)) {
      if (current.revision !== baseline.revision) throw new Error('Do not edit the settings base revision; change only values.')
      if (JSON.stringify(current.frontier) !== JSON.stringify(baseline.frontier)) throw new Error('Do not edit the settings causal frontier; change only values.')
      const changes: Partial<RemoteSettings> = {}
      if (current.values.autoLink !== baseline.values.autoLink) changes.autoLink = current.values.autoLink
      if (current.values.tunnelEnabled !== baseline.values.tunnelEnabled) changes.tunnelEnabled = current.values.tunnelEnabled
      if (current.values.connectTimeoutMs !== baseline.values.connectTimeoutMs) changes.connectTimeoutMs = current.values.connectTimeoutMs
      if (Object.keys(changes).length) {
        if (baseline.frontier) await this.options.apply(baseline.revision, changes, baseline.frontier)
        else await this.options.apply(baseline.revision, changes)
      }
    }
    const desired = projectionSchema.parse({ schemaVersion: 1, ...await this.options.read() })
    if (JSON.stringify(current) === JSON.stringify(desired) && JSON.stringify(baseline) === JSON.stringify(desired)) return
    // Refuse to overwrite another editor save that occurred during the async apply.
    const latest = await this.document(this.file)
    if (JSON.stringify(latest) !== JSON.stringify(current)) throw new Error('The editable settings changed while being applied. Retry with the saved file intact.')
    await writeJsonAtomic(`${this.file}.export`, { schemaVersion: 1, previous: current ?? null, next: desired })
    await writeJsonAtomic(this.file, desired)
    await writeJsonAtomic(`${this.file}.baseline`, desired)
    await rm(`${this.file}.export`)
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('The settings editor is closed.')
    await mkdir(dirname(this.file), { recursive: true })
    await this.refresh()
    this.watcher = watch(dirname(this.file), (_event, name) => {
      if (this.closed || name !== basename(this.file)) return
      clearTimeout(this.timer)
      this.timer = setTimeout(() => { void this.refresh().catch(this.options.onError) }, 50)
      this.timer.unref()
    })
    this.watcher.on('error', this.options.onError)
  }

  refresh(): Promise<void> {
    return this.queue(async () => {
      if (this.closed) return
      await this.recoverExport()
      // A missing editor document after initialization is not a request to reset settings.
      if (await this.document(`${this.file}.baseline`)) {
        try { await access(this.file) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('The editable settings file was removed. Restore it or reopen the editor; no setting was deleted.')
          throw error
        }
      }
      await this.reconcile()
    })
  }

  async close(): Promise<void> {
    this.closed = true
    clearTimeout(this.timer)
    this.watcher?.close()
    await this.pending
  }
}
