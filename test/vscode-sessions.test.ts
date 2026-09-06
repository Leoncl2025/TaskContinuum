import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseVSCodeSession, VSCodeSessionStore } from '../src/main/vscodeSessions'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

function journal(records: unknown[]): string { return records.map((record) => JSON.stringify(record)).join('\n') + '\n' }

describe('VS Code conversation import', () => {
  it('replays snapshots, field replacements, and appended requests without importing tools or reasoning', () => {
    const text = journal([
      { kind: 0, v: { requests: [], customTitle: 'Existing work' } },
      { kind: 2, k: ['requests'], v: [{ message: { text: 'Continue my work' }, response: [] }] },
      { kind: 1, k: ['requests', 0, 'response'], v: [{ value: 'Previous response' }, { kind: 'thinking', value: 'Private reasoning' }, { kind: 'toolInvocation', value: 'Do not execute this' }] },
      { kind: 2, k: ['requests', 0, 'response', 0, 'value'], v: ' preserved' },
    ])
    const parsed = parseVSCodeSession(text, true)
    expect(parsed.title).toBe('Existing work')
    expect(parsed.messages.map((message) => message.text)).toEqual(['Continue my work', 'Previous response preserved'])
  })

  it('ignores only a partially written final record', () => {
    const snapshot = journal([{ kind: 0, v: { requests: [{ message: { text: 'Saved prompt' }, response: [] }] } }])
    expect(parseVSCodeSession(snapshot + '{"kind":', true).messages).toHaveLength(1)
    expect(() => parseVSCodeSession(snapshot + '{bad}\n{}\n', true)).toThrow()
  })

  it('supports the array truncation records emitted by current VS Code', () => {
    const text = journal([
      { kind: 0, v: { requests: [{ message: { text: 'Keep' } }, { message: { text: 'Removed' } }], pendingRequests: ['pending'] } },
      { kind: 2, k: ['pendingRequests'], i: 0 },
      { kind: 2, k: ['requests'], i: 1, v: [{ message: { text: 'Replacement' } }] },
    ])
    expect(parseVSCodeSession(text, true).messages.map((message) => message.text)).toEqual(['Keep', 'Replacement'])
  })

  it('rejects prototype traversal and unknown operations', () => {
    const initial = { kind: 0, v: { requests: [] } }
    expect(() => parseVSCodeSession(journal([initial, { kind: 1, k: ['__proto__', 'polluted'], v: true }]), true)).toThrow('Unsafe')
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false)
    expect(() => parseVSCodeSession(journal([initial, { kind: 9, k: ['requests'], v: [] }]), true)).toThrow('Unsupported')
  })

  it('reads legacy JSON transcripts', () => {
    const parsed = parseVSCodeSession(JSON.stringify({ requests: [{ message: 'Original question', response: [{ kind: 'markdownContent', content: { value: 'Original answer' } }] }] }), false)
    expect(parsed.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(parsed.title).toBe('Original question')
  })

  it('discovers known session files read-only and does not accept arbitrary paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskcontinuum-import-'))
    directories.push(root)
    const workspace = join(root, 'a'.repeat(32))
    await mkdir(join(workspace, 'chatSessions'), { recursive: true })
    await writeFile(join(workspace, 'workspace.json'), JSON.stringify({ folder: 'file:///Q:/src/Projects' }))
    const file = join(workspace, 'chatSessions', 'session.jsonl')
    const original = journal([{ kind: 0, v: { requests: [{ message: { text: 'A local conversation' } }] } }])
    await writeFile(file, original)
    const store = new VSCodeSessionStore([root])
    const listing = await store.list()
    expect(listing.sessions).toHaveLength(1)
    expect(listing.warnings).toEqual([])
    expect((await store.read(listing.sessions[0].id)).messages[0].text).toBe('A local conversation')
    await expect(store.read(file)).rejects.toThrow('no longer listed')
    expect(await readFile(file, 'utf8')).toBe(original)
  })
})