import { readdir, readFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import type { Stats } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChatMessage } from '../shared/chat'
import type { LocalSessionSummary, SessionListing, SessionSnapshot } from '../shared/sessions'
import { checkedVSCodeIdentity, identityFromVSCodeHistory } from '../shared/vscodeChat'
import type { VSCodeChatIdentity } from '../shared/vscodeChat'

type JsonObject = Record<string, unknown>
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype'])
const maximumFileBytes = 32 * 1024 * 1024
const maximumJournalBytes = 256 * 1024 * 1024

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' ? value as JsonObject : {}
}

function applyRecord(snapshot: JsonObject, record: JsonObject): JsonObject {
  if (record.kind === 0) return object(record.v)
  if (record.kind !== 1 && record.kind !== 2) throw new Error('Unsupported VS Code journal operation.')
  if (!Array.isArray(record.k) || !record.k.length || record.k.length > 40) throw new Error('Invalid VS Code journal path.')
  const keys = record.k as unknown[]
  if (keys.some((key) => typeof key !== 'string' && typeof key !== 'number'
    || forbiddenKeys.has(String(key)) || typeof key === 'number' && (!Number.isSafeInteger(key) || key < 0 || key > 100000))) {
    throw new Error('Unsafe VS Code journal path.')
  }
  let parent = snapshot
  for (const key of keys.slice(0, -1)) {
    if (!Object.hasOwn(parent, String(key)) || parent[String(key)] === null || typeof parent[String(key)] !== 'object') {
      throw new Error('Invalid VS Code journal parent.')
    }
    parent = parent[String(key)] as JsonObject
  }
  const key = String(keys.at(-1))
  if (record.kind === 1) {
    if (Object.hasOwn(record, 'v')) parent[key] = record.v
    else delete parent[key]
  } else if (Array.isArray(parent[key]) && (record.v === undefined || Array.isArray(record.v))) {
    const index = record.i ?? parent[key].length
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index > parent[key].length) {
      throw new Error('Invalid VS Code journal splice index.')
    }
    parent[key] = [...parent[key].slice(0, index), ...(record.v ?? [])]
  } else if (typeof parent[key] === 'string' && typeof record.v === 'string') {
    parent[key] += record.v
  } else throw new Error('Invalid VS Code journal append.')
  return snapshot
}

export interface VSCodeOriginalTurn { id?: string; prompt: string; complete: boolean; cancelled: boolean; error?: string }
export interface VSCodeOriginalState {
  title: string
  messages: ChatMessage[]
  turns: VSCodeOriginalTurn[]
  mode?: { id: string; kind: string }
  hasDraft: boolean
}

function recordedName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && !/^(you|user)$/i.test(value.trim()) ? value.trim().slice(0, 300) : undefined
}

export function parseVSCodeSession(text: string, journal: boolean): VSCodeOriginalState {
  let snapshot: JsonObject
  if (journal) {
    snapshot = {}
    const lines = text.split('\n')
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue
      let record: JsonObject
      try { record = object(JSON.parse(line)) } catch (error) {
        if (index === lines.length - 1) break
        throw error
      }
      snapshot = applyRecord(snapshot, record)
    }
  } else snapshot = object(JSON.parse(text))
  return originalState(snapshot)
}

function originalState(snapshot: JsonObject): VSCodeOriginalState {
  const messages: ChatMessage[] = []
  const turns: VSCodeOriginalTurn[] = []
  if (!Array.isArray(snapshot.requests)) throw new Error('No supported VS Code conversation snapshot found.')
  for (const [index, entry] of snapshot.requests.entries()) {
    const request = object(entry)
    const message = object(request.message)
    const prompt = typeof message.text === 'string' ? message.text : typeof request.message === 'string' ? request.message : ''
    const requestId = typeof request.requestId === 'string' ? request.requestId : typeof request.id === 'string' ? request.id : undefined
    const result = object(request.result)
    const error = object(result.errorDetails).message
    const cancelled = request.isCanceled === true
    const complete = request.result !== undefined && request.result !== null || cancelled
    turns.push({ id: requestId, prompt, complete, cancelled, ...(typeof error === 'string' ? { error } : {}) })
    const username = recordedName(request.username) ?? recordedName(snapshot.requesterUsername)
    if (prompt.trim()) messages.push({ id: `vscode-user-${index}`, role: 'user', text: prompt, status: 'complete', ...(requestId ? { nativeRequestId: requestId } : {}), ...(username ? { author: { name: username } } : {}) })
    const response = Array.isArray(request.response) ? request.response.map((part: unknown) => {
      const chunk = object(part)
      if (chunk.kind !== undefined && chunk.kind !== 'markdownContent') return ''
      return typeof chunk.value === 'string' ? chunk.value : typeof object(chunk.content).value === 'string' ? String(object(chunk.content).value) : ''
    }).filter(Boolean).join('\n\n') : ''
    const agent = object(request.agent)
    const agentName = recordedName(agent.fullName) ?? recordedName(agent.name) ?? recordedName(snapshot.responderUsername)
    if (response.trim()) messages.push({ id: `vscode-assistant-${index}`, role: 'assistant', text: response, status: 'complete', ...(requestId ? { nativeRequestId: requestId } : {}), ...(agentName ? { author: { name: agentName } } : {}) })
  }
  const title = typeof snapshot.customTitle === 'string' ? snapshot.customTitle
    : messages.find((message) => message.role === 'user')?.text.split('\n')[0] ?? 'VS Code conversation'
  const input = object(snapshot.inputState)
  const mode = object(input.mode)
  return { title: title.slice(0, 160), messages, turns,
    ...(typeof mode.id === 'string' && typeof mode.kind === 'string' ? { mode: { id: mode.id, kind: mode.kind } } : {}),
    hasDraft: typeof input.inputText === 'string' && Boolean(input.inputText.trim()),
  }
}

export function defaultVSCodeRoots(): string[] {
  const override = process.env.TASKCONTINUUM_VSCODE_USER_DATA_DIR
  if (override) return [join(override, 'User', 'workspaceStorage')]
  const config = process.platform === 'win32' ? process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return ['Code', 'Code - Insiders'].map((name) => join(config, name, 'User', 'workspaceStorage'))
}

async function readBounded(file: string): Promise<string> {
  const details = await stat(file)
  if (!details.isFile() || details.size > maximumFileBytes) throw new Error('Conversation exceeds the 32 MB import limit.')
  return readFile(file, 'utf8')
}

async function readJournal(file: string, size: number): Promise<VSCodeOriginalState> {
  let snapshot: JsonObject = {}
  let recordBytes = 0
  const fragments: Buffer[] = []
  function replayRecord(partial: boolean): void {
    const text = Buffer.concat(fragments, recordBytes).toString('utf8')
    fragments.length = 0
    recordBytes = 0
    if (!text.trim()) return
    let record: JsonObject
    try { record = object(JSON.parse(text)) } catch (error) {
      if (partial && error instanceof SyntaxError) return
      throw error
    }
    snapshot = applyRecord(snapshot, record)
  }
  if (size > 0) {
    const stream = createReadStream(file, { end: size - 1, highWaterMark: 64 * 1024 })
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      let offset = 0
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset)
        const end = newline < 0 ? bytes.length : newline
        recordBytes += end - offset
        if (recordBytes > maximumFileBytes) throw new Error('A VS Code journal record exceeds the 32 MiB limit.')
        fragments.push(bytes.subarray(offset, end))
        if (newline < 0) break
        replayRecord(false)
        offset = end + 1
      }
    }
    replayRecord(true)
  }
  return originalState(snapshot)
}

export class VSCodeSessionStore {
  private readonly roots: string[]
  private readonly files = new Map<string, { file: string; summary: LocalSessionSummary }>()
  private cachedState?: { file: string; fingerprint: string; value: Promise<VSCodeOriginalState> }

  constructor(roots = defaultVSCodeRoots()) { this.roots = roots }

  private async readState(file: string, details?: Stats): Promise<VSCodeOriginalState> {
    const info = details ?? await stat(file)
    const journal = file.endsWith('.jsonl')
    if (!info.isFile()) throw new Error('The VS Code history path is not a regular file.')
    if (info.size > (journal ? maximumJournalBytes : maximumFileBytes)) throw new Error(journal ? 'The VS Code journal exceeds the 256 MiB limit.' : 'Conversation exceeds the 32 MB import limit.')
    const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
    if (this.cachedState?.file !== file || this.cachedState.fingerprint !== fingerprint) {
      const entry = { file, fingerprint, value: journal ? readJournal(file, info.size) : readBounded(file).then((text) => parseVSCodeSession(text, false)) }
      this.cachedState = entry
      void entry.value.catch(() => { if (this.cachedState === entry) this.cachedState = undefined })
    }
    return structuredClone(await this.cachedState.value)
  }

  async list(): Promise<SessionListing> {
    const sessions: LocalSessionSummary[] = []
    const warnings: string[] = []
    this.files.clear()
    for (const [rootIndex, root] of this.roots.entries()) {
      const workspaces = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') warnings.push(`VS Code storage could not be read: ${root}`)
        return []
      })
      for (const workspace of workspaces) {
        if (!workspace.isDirectory() || !/^[a-f\d]{32}$/i.test(workspace.name)) continue
        const base = join(root, workspace.name)
        let workingDirectory: string | undefined
        try {
          const metadata = object(JSON.parse(await readBounded(join(base, 'workspace.json'))))
          if (typeof metadata.folder === 'string' && metadata.folder.startsWith('file:')) workingDirectory = fileURLToPath(metadata.folder)
          else if (typeof metadata.workspace === 'string' && metadata.workspace.startsWith('file:')) workingDirectory = dirname(fileURLToPath(metadata.workspace))
        } catch { workingDirectory = undefined }
        const files = await readdir(join(base, 'chatSessions'), { withFileTypes: true }).catch(() => [])
        for (const entry of files) {
          if (!entry.isFile() || !/^[\w-]+\.jsonl?$/.test(entry.name)) continue
          const file = join(base, 'chatSessions', entry.name)
          try {
            const details = await stat(file)
            const parsed = await this.readState(file, details)
            if (!parsed.messages.length) continue
            const id = `vscode:${rootIndex}:${workspace.name}:${entry.name}`
            const summary: LocalSessionSummary = { id, source: 'vscode', title: parsed.title, workingDirectory,
              updatedAt: details.mtime.toISOString(), messageCount: parsed.messages.length }
            sessions.push(summary)
            this.files.set(id, { file, summary })
          } catch (error) {
            const reason = error instanceof SyntaxError ? 'History contains invalid JSON.' : error instanceof Error ? error.message.slice(0, 200) : 'History could not be read.'
            warnings.push(`Skipped an unreadable VS Code conversation: ${entry.name}. ${reason}`)
          }
        }
      }
    }
    return { sessions: sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), warnings }
  }

  async read(id: string): Promise<SessionSnapshot> {
    const entry = this.files.get(id)
    if (!entry) throw new Error('Conversation is no longer listed. Refresh the session list.')
    const parsed = await this.readState(entry.file)
    return { session: entry.summary, messages: parsed.messages }
  }

  async locateOriginal(value: VSCodeChatIdentity): Promise<{ file: string; bridgeDirectory: string; uriScheme: 'vscode' | 'vscode-insiders'; snapshot: SessionSnapshot; state: VSCodeOriginalState }> {
    const identity = checkedVSCodeIdentity(value)
    const matches = this.roots.flatMap((root) => ['jsonl', 'json'].map((extension) => ({
      root, file: join(root, identity.workspaceStorageId, 'chatSessions', `${identity.nativeSessionId}.${extension}`),
    })))
    const found: { root: string; file: string; details: Stats }[] = []
    for (const entry of matches) {
      try {
        const details = await stat(entry.file)
        if (!details.isFile()) throw new Error('The VS Code history path is not a regular file.')
        found.push({ ...entry, details })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (!found.length) throw new Error('The linked VS Code conversation is unavailable in this local profile. Its task link was kept; no new session was created.')
    if (new Set(found.map((entry) => entry.root)).size !== 1) throw new Error('This VS Code conversation exists in multiple profiles. Select the source profile before opening it.')
    const entry = found.find((candidate) => candidate.file.endsWith('.jsonl')) ?? found[0]
    const parsed = await this.readState(entry.file, entry.details)
    const id = `vscode:${this.roots.indexOf(entry.root)}:${identity.workspaceStorageId}:${identity.nativeSessionId}.${entry.file.endsWith('.jsonl') ? 'jsonl' : 'json'}`
    identityFromVSCodeHistory(id)
    let workingDirectory: string | undefined
    try {
      const metadata = object(JSON.parse(await readBounded(join(entry.root, identity.workspaceStorageId, 'workspace.json'))))
      if (typeof metadata.folder === 'string' && metadata.folder.startsWith('file:')) workingDirectory = fileURLToPath(metadata.folder)
      else if (typeof metadata.workspace === 'string' && metadata.workspace.startsWith('file:')) workingDirectory = dirname(fileURLToPath(metadata.workspace))
    } catch { workingDirectory = undefined }
    return {
      file: entry.file,
      bridgeDirectory: join(entry.root, identity.workspaceStorageId, 'taskcontinuum.vscode-bridge', 'bridges'),
      uriScheme: basename(dirname(dirname(entry.root))) === 'Code - Insiders' ? 'vscode-insiders' : 'vscode',
      snapshot: { session: { id, source: 'vscode', title: parsed.title, updatedAt: entry.details.mtime.toISOString(), workingDirectory, messageCount: parsed.messages.length }, messages: parsed.messages },
      state: parsed,
    }
  }
}