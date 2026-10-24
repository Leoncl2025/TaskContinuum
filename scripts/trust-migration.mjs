import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const entry = join(root, 'out', 'cli', 'taskcontinuum-migrate.cjs')
if (!existsSync(entry)) {
  console.error('The fixed migration build is missing. Run npm run build:cli in the approved isolated code worktree first.')
  process.exitCode = 1
} else {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const temporary = mkdtempSync(join(tmpdir(), 'tc-migration-launch-'))
  env.TASKCONTINUUM_MIGRATION_BOOTSTRAP = temporary
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    try { rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    catch { console.error('The isolated migration-launch temporary directory could not be removed. No original profile was modified.'); process.exitCode = 1 }
  }
  const child = spawn(require('electron'), [join(root, 'scripts', 'trust-migration-bootstrap.mjs'), ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true, shell: false })
  child.on('error', () => { console.error('The migration helper could not start. No Task Continuum process was stopped.'); process.exitCode = 1; cleanup() })
  child.on('exit', (code) => { process.exitCode = code ?? 1; cleanup() })
}
