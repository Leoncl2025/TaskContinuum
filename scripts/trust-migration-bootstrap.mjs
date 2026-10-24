import { app } from 'electron'
import { createRequire } from 'node:module'
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

app.setName('Task Continuum Migration Helper')
try {
  const temporary = process.env.TASKCONTINUUM_MIGRATION_BOOTSTRAP
  if (!temporary || !isAbsolute(temporary) || !lstatSync(temporary).isDirectory()
    || lstatSync(temporary).isSymbolicLink() || realpathSync(temporary) !== temporary) {
    throw new Error('The isolated launch directory is unavailable.')
  }
  app.setPath('userData', temporary)
  app.setPath('sessionData', temporary)
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  createRequire(import.meta.url)(join(root, 'out', 'cli', 'taskcontinuum-migrate.cjs'))
} catch {
  console.error('Migration bootstrap failed. Use npm run migrate:trust with the approved build; no original profile was opened.')
  app.exit(1)
}
