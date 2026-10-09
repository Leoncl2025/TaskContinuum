import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface UpdatePreferences {
  load(): Promise<boolean>
  save(enabled: boolean): Promise<void>
}

export function fileUpdatePreferences(userData: string): UpdatePreferences {
  const path = join(userData, 'update-preferences.json')
  return {
    async load() {
      let content: string
      try {
        content = await readFile(path, 'utf8')
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true
        throw error
      }
      const value: unknown = JSON.parse(content)
      if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1 ||
          !('autoCheck' in value) || typeof value.autoCheck !== 'boolean' ||
          Object.keys(value).some(key => key !== 'schemaVersion' && key !== 'autoCheck')) {
        throw new Error('Invalid update preferences. Choose automatic checking again to repair the configuration.')
      }
      return value.autoCheck
    },
    async save(autoCheck) {
      await mkdir(dirname(path), { recursive: true })
      const staging = `${path}.${randomUUID()}.new`
      try {
        await writeFile(staging, `${JSON.stringify({ schemaVersion: 1, autoCheck })}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        await rename(staging, path)
      } finally {
        await rm(staging, { force: true })
      }
    },
  }
}
