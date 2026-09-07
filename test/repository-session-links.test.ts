import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateRepositorySessionLinks, readRepositorySessionLinks, updateRepositorySessionLink } from '../src/main/repositorySessionLinks'
import { sessionLinksPath } from '../src/shared/sessionBindings'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

async function folder() {
  const root = await mkdtemp(join(tmpdir(), 'taskcontinuum-links-'))
  directories.push(root)
  return root
}

describe('versioned task/session links', () => {
  it('does not create a file just by reading an unlinked workspace', async () => {
    const root = await folder()
    expect(await readRepositorySessionLinks(root)).toEqual({ document: { schemaVersion: 1, bindings: {} }, revision: null })
    expect(await readdir(root)).toEqual([])
  })

  it('persists portable IDs without titles, machine paths, transcripts, or credentials', async () => {
    const root = await folder()
    const saved = await updateRepositorySessionLink(root, 'T-0002', 'copilot-session-one', null)
    const content = await readFile(join(root, sessionLinksPath), 'utf8')
    expect(JSON.parse(content)).toEqual({ schemaVersion: 1, bindings: { 'T-0002': { provider: 'github-copilot', sessionId: 'copilot-session-one' } } })
    expect(content).not.toContain(root)
    expect(content).toBe(JSON.stringify(saved.document, null, 2) + '\n')
    const clone = await folder()
    await mkdir(join(clone, '.taskcontinuum'))
    await writeFile(join(clone, sessionLinksPath), content)
    expect(await readRepositorySessionLinks(clone)).toEqual(saved)
  })

  it('links the original VS Code identity without changing native CLI bindings or creating a session', async () => {
    const root = await folder()
    const first = await updateRepositorySessionLink(root, 'T-0002', 'original-session', null)
    const second = await updateRepositorySessionLink(root, 'T-0003', 'original-session', first.revision, 'a'.repeat(32))
    expect(second.document.bindings['T-0003']).toEqual({ provider: 'vscode-copilot', sessionId: 'original-session', workspaceStorageId: 'a'.repeat(32) })
    expect(second.document.bindings['T-0002']).toEqual(first.document.bindings['T-0002'])
    await expect(updateRepositorySessionLink(root, 'T-0004', 'original-session', second.revision, 'a'.repeat(32))).rejects.toThrow('already linked to T-0003')
    expect(await readRepositorySessionLinks(root)).toEqual(second)
    expect(await readFile(join(root, sessionLinksPath), 'utf8')).not.toContain(root)
  })

  it('preserves other task links and never implicitly moves a session to another task', async () => {
    const root = await folder()
    const first = await updateRepositorySessionLink(root, 'T-0002', 'first-session', null)
    const second = await updateRepositorySessionLink(root, 'T-0003', 'second-session', first.revision)
    await expect(updateRepositorySessionLink(root, 'T-0003', 'first-session', second.revision)).rejects.toThrow('already linked to T-0002')
    const detached = await updateRepositorySessionLink(root, 'T-0002', null, second.revision)
    expect(detached.document.bindings).toEqual({ 'T-0003': { provider: 'github-copilot', sessionId: 'second-session' } })
    expect(await readdir(join(root, '.taskcontinuum'))).toEqual(['.gitignore', 'session-bindings.json'])
    expect(await readFile(join(root, '.taskcontinuum', '.gitignore'), 'utf8')).toBe('session-bindings.lock\nsession-bindings.*.tmp\n')
  })

  it('does not overwrite changed data or unresolved merge conflicts', async () => {
    const root = await folder()
    const first = await updateRepositorySessionLink(root, 'T-0002', 'first-session', null)
    const updated = await updateRepositorySessionLink(root, 'T-0003', 'second-session', first.revision)
    await expect(updateRepositorySessionLink(root, 'T-0002', null, first.revision)).rejects.toThrow('changed on disk')
    expect(await readRepositorySessionLinks(root)).toEqual(updated)
    const conflict = '<<<<<<< ours\n{}\n=======\n{}\n>>>>>>> theirs\n'
    await writeFile(join(root, sessionLinksPath), conflict)
    await expect(updateRepositorySessionLink(root, 'T-0002', null, updated.revision)).rejects.toThrow('merge conflict')
    expect(await readFile(join(root, sessionLinksPath), 'utf8')).toBe(conflict)
  })

  it('rejects unsafe storage links and simultaneous writers', async () => {
    const root = await folder()
    const outside = await folder()
    await symlink(outside, join(root, '.taskcontinuum'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(updateRepositorySessionLink(root, 'T-0002', 'session', null)).rejects.toThrow('real directory')
    expect(await readdir(outside)).toEqual([])
    const locked = await folder()
    await mkdir(join(locked, '.taskcontinuum'))
    await writeFile(join(locked, '.taskcontinuum', 'session-bindings.lock'), '')
    await expect(updateRepositorySessionLink(locked, 'T-0002', 'session', null)).rejects.toThrow('another process')
    expect(await readdir(join(locked, '.taskcontinuum'))).toEqual(['session-bindings.lock'])
  })

  it('migrates legacy links atomically only when there is no repository document', async () => {
    const root = await folder()
    const bindings = { 'T-0002': { provider: 'github-copilot' as const, sessionId: 'existing-session' }, 'T-0003': { provider: 'github-copilot' as const, sessionId: 'second-session' } }
    const saved = await migrateRepositorySessionLinks(root, bindings)
    expect(saved.document.bindings).toEqual(bindings)
    await expect(migrateRepositorySessionLinks(root, bindings)).rejects.toThrow('changed on disk')
    expect(await readRepositorySessionLinks(root)).toEqual(saved)
    const duplicate = await folder()
    await expect(migrateRepositorySessionLinks(duplicate, { ...bindings, 'T-0004': bindings['T-0002'] })).rejects.toThrow()
    expect(await readdir(duplicate)).toEqual([])
  })

  it('preserves existing metadata ignore rules', async () => {
    const root = await folder()
    await mkdir(join(root, '.taskcontinuum'))
    const ignore = 'session-bindings.lock\nsession-bindings.*.tmp\ncustom-local-state/\n'
    await writeFile(join(root, '.taskcontinuum', '.gitignore'), ignore)
    await updateRepositorySessionLink(root, 'T-0002', 'session-one', null)
    expect(await readFile(join(root, '.taskcontinuum', '.gitignore'), 'utf8')).toBe(ignore)
  })
})