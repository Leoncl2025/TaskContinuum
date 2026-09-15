import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalSettingsFile } from '../src/main/remoteConfig/settingsFile'

const roots: string[] = []
const editors: LocalSettingsFile[] = []
afterEach(async () => {
  for (const editor of editors.splice(0)) await editor.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'taskcon-settings-'))
  roots.push(root)
  const file = join(root, 'settings.json')
  let state = { revision: 'a'.repeat(64), values: { autoLink: true, tunnelEnabled: true, connectTimeoutMs: 45000 } }
  const apply = vi.fn(async (revision: string | null, changes: Partial<typeof state.values>) => {
    if (state.revision !== revision) throw new Error('Settings revision changed; proposal retained.')
    state = { revision: 'b'.repeat(64), values: { ...state.values, ...changes } }
  })
  const onError = vi.fn()
  const editor = new LocalSettingsFile(file, { read: async () => state, apply, onError })
  editors.push(editor)
  await editor.start()
  return { file, editor, apply, onError, advance: () => { state = { ...state, revision: 'c'.repeat(64) } } }
}

describe('editable local configuration projection', () => {
  it('turns a file edit into one validated command and does not echo refreshed projections', async () => {
    const { file, editor, apply } = await fixture()
    const proposal = JSON.parse(await readFile(file, 'utf8'))
    proposal.values.autoLink = false
    await writeFile(file, JSON.stringify(proposal))
    await editor.refresh()
    expect(apply).toHaveBeenCalledExactlyOnceWith('a'.repeat(64), { autoLink: false })
    await editor.refresh()
    expect(apply).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await readFile(file, 'utf8')).revision).toBe('b'.repeat(64))
  })

  it('preserves invalid or stale edits rather than silently resetting settings', async () => {
    const { file, editor, apply, advance } = await fixture()
    const proposal = JSON.parse(await readFile(file, 'utf8'))
    proposal.values.connectTimeoutMs = 10000
    const text = JSON.stringify(proposal)
    await writeFile(file, text)
    advance()
    await expect(editor.refresh()).rejects.toThrow('proposal retained')
    expect(await readFile(file, 'utf8')).toBe(text)
    await writeFile(file, '{"invalid":true}')
    await expect(editor.refresh()).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe('{"invalid":true}')
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('recovers an interrupted generated projection without replaying it as a user edit', async () => {
    const { file, editor, apply, advance } = await fixture()
    const previous = JSON.parse(await readFile(file, 'utf8'))
    advance()
    const next = { ...previous, revision: 'c'.repeat(64) }
    await writeFile(`${file}.export`, JSON.stringify({ schemaVersion: 1, previous, next }))
    await writeFile(file, JSON.stringify(next))
    await editor.refresh()
    expect(apply).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(`${file}.baseline`, 'utf8'))).toEqual(next)
    await expect(readFile(`${file}.export`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
