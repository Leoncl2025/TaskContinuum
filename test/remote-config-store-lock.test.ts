// @vitest-environment node
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { renameSync, writeFileSync } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireStoreLock } from '../src/main/remoteConfig/storeLock'
import type { StoreLock } from '../src/main/remoteConfig/storeLock'

const workspaceId = randomUUID()
const directories: string[] = []
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-store-lock-'))
  directories.push(directory)
  return { directory, file: join(directory, 'store.lock'), recoveryFile: join(directory, 'store-recovery.lock') }
}
function owner(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 1, workspaceId, pid: process.pid, host: hostname(), nonce: randomUUID(), ...overrides }
}
async function childOwner(file: string) {
  const child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const handle = fs.openSync(process.argv[1], 'wx', 0o600);
    fs.writeFileSync(handle, JSON.stringify({
      schemaVersion: 1, workspaceId: process.argv[2], pid: process.pid,
      host: require('node:os').hostname(), nonce: require('node:crypto').randomUUID()
    }));
    fs.fsyncSync(handle);
    process.stdout.write('ready');
    setInterval(() => {}, 1000);
  `, file, workspaceId], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
  }
  try {
    await Promise.race([
      once(child.stdout, 'data'),
      exited.then(() => { throw new Error('The lock fixture exited before acquiring its lock.') }),
    ])
    return { child, stop }
  } catch (error) { await stop(); throw error }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('configuration store process ownership', () => {
  it('persists ownership, excludes a live contender even for an old lock, and releases idempotently', async () => {
    const f = await fixture()
    const lock = await acquireStoreLock(f.directory, workspaceId)
    try {
      expect(lock.recovered).toBe(false)
      const content = await readFile(f.file, 'utf8')
      expect(JSON.parse(content)).toEqual(owner({ nonce: expect.any(String) }))
      const identity = await lstat(f.file, { bigint: true })
      expect(lock.identity).toEqual({ dev: identity.dev, ino: identity.ino })
      await utimes(f.file, new Date(0), new Date(0))
      await expect(acquireStoreLock(f.directory, workspaceId)).rejects.toThrow(`live process (PID ${process.pid})`)
      expect(await readFile(f.file, 'utf8')).toBe(content)
      expect(await readdir(f.directory)).toEqual(['store.lock'])
    } finally { await lock.release() }
    await lock.release()
    expect(await readdir(f.directory)).toEqual([])
  })

  it('does not steal a child process lock, then recovers it after abrupt process exit', async () => {
    const f = await fixture()
    const holder = await childOwner(f.file)
    try {
      const content = await readFile(f.file, 'utf8')
      await expect(acquireStoreLock(f.directory, workspaceId)).rejects.toThrow(`live process (PID ${holder.child.pid})`)
      expect(await readFile(f.file, 'utf8')).toBe(content)
    } finally { await holder.stop() }
    const lock = await acquireStoreLock(f.directory, workspaceId)
    try {
      expect(lock.recovered).toBe(true)
      expect(JSON.parse(await readFile(f.file, 'utf8')).pid).toBe(process.pid)
      expect(await readdir(f.directory)).toEqual(['store.lock'])
    } finally { await lock.release() }
  })

  it('admits only one simultaneous reclaimer after an owner exits', async () => {
    const f = await fixture()
    const holder = await childOwner(f.file)
    await holder.stop()
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => acquireStoreLock(f.directory, workspaceId)))
    const acquired = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    try {
      expect(acquired).toHaveLength(1)
      expect(acquired[0].recovered).toBe(true)
      for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'store-busy' })
      expect(JSON.parse(await readFile(f.file, 'utf8')).pid).toBe(process.pid)
    } finally { await Promise.all(acquired.map((lock) => lock.release())) }
  })

  it.each([
    ['empty legacy', ''],
    ['incomplete', '{'],
    ['unsupported', JSON.stringify(owner({ schemaVersion: 2 }))],
    ['invalid PID', JSON.stringify(owner({ pid: -1 }))],
    ['another workspace', JSON.stringify(owner({ workspaceId: randomUUID() }))],
    ['another machine', JSON.stringify(owner({ host: `${hostname()}-other` }))],
  ])('retains a %s lock and reports manual recovery instructions', async (_kind, content) => {
    const f = await fixture()
    await writeFile(f.file, content)
    const check = vi.spyOn(process, 'kill')
    await expect(acquireStoreLock(f.directory, workspaceId)).rejects.toThrow('Stop all Task Continuum instances')
    expect(check).not.toHaveBeenCalled()
    expect(await readFile(f.file, 'utf8')).toBe(content)
    expect(await readdir(f.directory)).toEqual(['store.lock'])
  })

  it('fails closed when the operating system cannot verify the owner', async () => {
    const f = await fixture()
    const content = JSON.stringify(owner())
    await writeFile(f.file, content)
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('Not permitted'), { code: 'EPERM' }) })
    await expect(acquireStoreLock(f.directory, workspaceId)).rejects.toThrow('process status could not be verified')
    expect(await readFile(f.file, 'utf8')).toBe(content)
  })

  it('retains both locks if a previous recovery guard cannot be acquired', async () => {
    const f = await fixture()
    const content = JSON.stringify(owner())
    await writeFile(f.file, content)
    await writeFile(f.recoveryFile, '')
    await expect(acquireStoreLock(f.directory, workspaceId)).rejects.toThrow('backing up store-recovery.lock')
    expect(await readFile(f.file, 'utf8')).toBe(content)
    expect(await readFile(f.recoveryFile, 'utf8')).toBe('')
  })

  it.each(['file', 'nonce'])('does not remove a replacement %s when releasing', async (replacement) => {
    const f = await fixture()
    const lock = await acquireStoreLock(f.directory, workspaceId)
    const content = await readFile(f.file, 'utf8')
    if (replacement === 'file') await rename(f.file, join(f.directory, 'original.lock'))
    const changed = replacement === 'nonce' ? JSON.stringify(owner()) : content
    await writeFile(f.file, changed)
    await expect(lock.release()).rejects.toThrow('replacement lock was not removed')
    expect(await readFile(f.file, 'utf8')).toBe(changed)
  })

  it('rechecks file identity before removing a stale owner', async () => {
    const f = await fixture()
    await writeFile(f.file, JSON.stringify(owner()))
    const replacement = JSON.stringify(owner())
    vi.spyOn(process, 'kill').mockImplementation(() => {
      renameSync(f.file, join(f.directory, 'original.lock'))
      writeFileSync(f.file, replacement)
      throw Object.assign(new Error('Exited'), { code: 'ESRCH' })
    })
    await expect(acquireStoreLock(f.directory, workspaceId)).rejects.toThrow('changed during recovery')
    expect(await readFile(f.file, 'utf8')).toBe(replacement)
    expect(await readdir(f.directory)).not.toContain('store-recovery.lock')
  })

  it.each(['hard-link', 'directory-link', 'oversized'])('does not reclaim an unsafe %s lock', async (kind) => {
    const f = await fixture()
    const outside = join(f.directory, 'outside')
    if (kind === 'directory-link') {
      await mkdir(outside)
      await symlink(outside, f.file, process.platform === 'win32' ? 'junction' : 'dir')
    } else {
      await writeFile(f.file, kind === 'oversized' ? 'x'.repeat(1025) : JSON.stringify(owner()))
      if (kind === 'hard-link') await link(f.file, outside)
    }
    const check = vi.spyOn(process, 'kill')
    await expect(acquireStoreLock(f.directory, workspaceId)).rejects.toMatchObject({ code: kind === 'oversized' ? 'resource-limit' : 'unsafe-path' })
    expect(check).not.toHaveBeenCalled()
    expect(await lstat(f.file)).toBeDefined()
  })

  it('releases an acquired lock even when a transaction fails', async () => {
    const f = await fixture()
    let lock: StoreLock | undefined
    const transaction = async () => {
      lock = await acquireStoreLock(f.directory, workspaceId)
      try { throw new Error('Validation failed') } finally { await lock.release() }
    }
    await expect(transaction()).rejects.toThrow('Validation failed')
    expect(await readdir(f.directory)).toEqual([])
  })
})
