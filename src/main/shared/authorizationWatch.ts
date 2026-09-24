import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { basename } from 'node:path'

export class AuthorizationWatch {
  private readonly watchers: FSWatcher[] = []
  private version = 0
  private failed = false
  private closed = false

  observe(directory: string, recursive: boolean, relevant: (name: string) => boolean = () => true): void {
    if (this.closed || this.failed) throw new Error('Authorization monitoring is unavailable.')
    try {
      const watcher = watch(directory, { persistent: false, recursive }, (event, name) => {
        if (name === null || event === 'rename' && String(name) === basename(directory) || relevant(String(name))) this.invalidate()
      })
      watcher.on('error', () => {
        this.failed = true
        this.invalidate()
        console.error('Authorization input monitoring failed; cached access is disabled.')
      })
      this.watchers.push(watcher)
    } catch (error) {
      this.failed = true
      this.invalidate()
      throw error
    }
  }

  invalidate(): void { this.version++ }
  checkpoint(): () => boolean {
    const version = this.version
    return () => !this.closed && !this.failed && version === this.version
  }
  close(): void {
    this.closed = true
    this.invalidate()
    for (const watcher of this.watchers) watcher.close()
    this.watchers.length = 0
  }
}
