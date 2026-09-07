import { appendFile, mkdtemp, mkdir, readFile, rm, truncate, utimes, writeFile } from 'node:fs/promises'
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

  it('preserves recorded authors and request state without attributing old history to the current machine', () => {
    const parsed = parseVSCodeSession(JSON.stringify({ requesterUsername: 'Alice', responderUsername: 'GitHub Copilot',
      inputState: { mode: { id: 'agent', kind: 'agent' }, inputText: '' },
      requests: [{ requestId: 'original-request', message: 'Recorded user question', response: [{ value: 'Recorded response' }], result: {} }],
    }), false)
    expect(parsed.messages.map((message) => message.author)).toEqual([{ name: 'Alice' }, { name: 'GitHub Copilot' }])
    expect(parsed.messages.map((message) => message.nativeRequestId)).toEqual(['original-request', 'original-request'])
    expect(parsed.turns).toEqual([{ id: 'original-request', prompt: 'Recorded user question', complete: true, cancelled: false }])
    expect(parsed.mode).toEqual({ id: 'agent', kind: 'agent' })
    expect(parsed.hasDraft).toBe(false)
    const unknown = parseVSCodeSession(JSON.stringify({ requesterUsername: 'You', requests: [{ message: 'An old message' }] }), false)
    expect(unknown.messages[0].author).toBeUndefined()
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

  it('locates a linked original after restart without listing or creating a new conversation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskcontinuum-original-'))
    directories.push(root)
    const workspaceStorageId = 'a'.repeat(32)
    const directory = join(root, workspaceStorageId, 'chatSessions')
    await mkdir(directory, { recursive: true })
    const file = join(directory, 'original.jsonl')
    const original = journal([{ kind: 0, v: { requests: [{ message: { text: 'Existing original' }, response: [{ value: 'Original answer' }] }] } }])
    await writeFile(file, original)
    const store = new VSCodeSessionStore([root])
    const result = await store.locateOriginal({ nativeSessionId: 'original', workspaceStorageId })
    expect(result.file).toBe(file)
    expect(result.snapshot.messages.map((message) => message.text)).toEqual(['Existing original', 'Original answer'])
    await expect(store.locateOriginal({ nativeSessionId: 'missing', workspaceStorageId })).rejects.toThrow('no new session was created')
    await expect(store.locateOriginal({ nativeSessionId: '../original', workspaceStorageId })).rejects.toThrow('Invalid')
    expect(await readFile(file, 'utf8')).toBe(original)
  })

  it('keeps a long JSONL conversation discoverable and reads its latest saved state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskcontinuum-long-original-'))
    directories.push(root)
    const workspaceStorageId = 'a'.repeat(32)
    const directory = join(root, workspaceStorageId, 'chatSessions')
    await mkdir(directory, { recursive: true })
    const file = join(directory, 'long-original.jsonl')
    const snapshot = { kind: 0, v: { customTitle: 'Long original conversation', inputState: { mode: { id: 'agent', kind: 'agent' }, inputText: '' }, requests: [{ requestId: 'original-request', message: 'Original question', response: [] }] } }
    const progress = { kind: 1, k: ['requests', 0, 'response'], v: [{ kind: 'toolInvocation', value: 'x'.repeat(256 * 1024) }] }
    const source = journal([snapshot]) + journal([progress]).repeat(132) + journal([
      { kind: 1, k: ['requests', 0, 'response'], v: [{ value: 'Latest saved answer' }] },
      { kind: 1, k: ['requests', 0, 'result'], v: {} },
    ])
    expect(Buffer.byteLength(source)).toBeGreaterThan(32 * 1024 * 1024)
    await writeFile(file, source)
    const store = new VSCodeSessionStore([root])
    const listing = await store.list()
    expect(listing.warnings).toEqual([])
    expect(listing.sessions).toEqual([expect.objectContaining({ title: 'Long original conversation' })])
    expect((await store.read(listing.sessions[0].id)).messages.map((message) => message.text)).toEqual(['Original question', 'Latest saved answer'])
    const original = await store.locateOriginal({ nativeSessionId: 'long-original', workspaceStorageId })
    expect(original.state.turns).toEqual([{ id: 'original-request', prompt: 'Original question', complete: true, cancelled: false }])
    expect(original.state.hasDraft).toBe(false)
    expect(await readFile(file, 'utf8')).toBe(source)
  })

  it('preserves UTF-8 across stream chunks and ignores only an unfinished final record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskcontinuum-stream-original-'))
    directories.push(root)
    const identity = { nativeSessionId: 'original', workspaceStorageId: 'a'.repeat(32) }
    const directory = join(root, identity.workspaceStorageId, 'chatSessions')
    await mkdir(directory, { recursive: true })
    const file = join(directory, 'original.jsonl')
    const text = '\u4f60\u597d\u{1f642}'.repeat(15000)
    const source = journal([{ kind: 0, v: { requests: [{ message: text, response: [] }] } }])
    await writeFile(file, source + '{"kind":')
    const store = new VSCodeSessionStore([root])
    expect((await store.locateOriginal(identity)).snapshot.messages[0].text).toBe(text)
    await writeFile(file, source.trimEnd())
    expect((await store.locateOriginal(identity)).snapshot.messages[0].text).toBe(text)
    await writeFile(file, source + '{bad}\n')
    await expect(store.locateOriginal(identity)).rejects.toBeInstanceOf(SyntaxError)
    const listing = await store.list()
    expect(listing.warnings[0]).toContain('History contains invalid JSON.')
    expect(listing.warnings[0]).not.toContain('{bad}')
  })

  it('refreshes cached history after append, rewrite, and deletion without sharing mutable state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskcontinuum-cache-original-'))
    directories.push(root)
    const identity = { nativeSessionId: 'original', workspaceStorageId: 'a'.repeat(32) }
    const directory = join(root, identity.workspaceStorageId, 'chatSessions')
    await mkdir(directory, { recursive: true })
    const file = join(directory, 'original.jsonl')
    const snapshot = { kind: 0, v: { requests: [{ message: 'Old prompt' }] } }
    await writeFile(file, journal([snapshot]))
    const store = new VSCodeSessionStore([root])
    const initial = await store.locateOriginal(identity)
    initial.state.turns[0].complete = true
    initial.snapshot.messages[0].text = 'Changed by a caller'
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => store.locateOriginal(identity)))
    expect(concurrent.every((value) => value.snapshot.messages[0].text === 'Old prompt' && !value.state.turns[0].complete)).toBe(true)
    await appendFile(file, journal([{ kind: 1, k: ['requests', 0, 'result'], v: {} }]))
    expect((await store.locateOriginal(identity)).state.turns[0].complete).toBe(true)
    await writeFile(file, journal([{ ...snapshot, v: { requests: [{ message: 'New prompt' }] } }]))
    const changedTime = new Date(Date.now() + 1000)
    await utimes(file, changedTime, changedTime)
    expect((await store.locateOriginal(identity)).snapshot.messages[0].text).toBe('New prompt')
    await rm(file)
    await expect(store.locateOriginal(identity)).rejects.toThrow('no new session was created')
    expect((await store.list()).sessions).toEqual([])
  })

  it('keeps explicit bounds for individual records, total journals, and legacy JSON files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskcontinuum-bounded-original-'))
    directories.push(root)
    const identity = { nativeSessionId: 'original', workspaceStorageId: 'a'.repeat(32) }
    const directory = join(root, identity.workspaceStorageId, 'chatSessions')
    await mkdir(directory, { recursive: true })
    const journalFile = join(directory, 'original.jsonl')
    await writeFile(journalFile, Buffer.alloc(32 * 1024 * 1024 + 1, 32))
    const store = new VSCodeSessionStore([root])
    await expect(store.locateOriginal(identity)).rejects.toThrow('journal record exceeds the 32 MiB limit')
    await truncate(journalFile, 256 * 1024 * 1024 + 1)
    await expect(store.locateOriginal(identity)).rejects.toThrow('journal exceeds the 256 MiB limit')
    expect((await store.list()).warnings[0]).toContain('journal exceeds the 256 MiB limit')
    await rm(journalFile)
    const jsonFile = join(directory, 'original.json')
    await writeFile(jsonFile, '{}')
    await truncate(jsonFile, 32 * 1024 * 1024 + 1)
    await expect(store.locateOriginal(identity)).rejects.toThrow('32 MB import limit')
  })
})