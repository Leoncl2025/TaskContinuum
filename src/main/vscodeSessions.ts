import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChatMessage } from '../shared/chat'
import type { LocalSessionSummary, SessionListing, SessionSnapshot } from '../shared/sessions'

type JsonObject = Record<string, unknown>
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype'])
const maximumFileBytes = 32 * 1024 * 1024

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

export function parseVSCodeSession(text: string, journal: boolean): { title: string; messages: ChatMessage[] } {
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
  const messages: ChatMessage[] = []
  if (!Array.isArray(snapshot.requests)) throw new Error('No supported VS Code conversation snapshot found.')
  for (const [index, entry] of snapshot.requests.entries()) {
    const request = object(entry)
    const message = object(request.message)
    const prompt = typeof message.text === 'string' ? message.text : typeof request.message === 'string' ? request.message : ''
    if (prompt.trim()) messages.push({ id: `vscode-user-${index}`, role: 'user', text: prompt, status: 'complete' })
    const response = Array.isArray(request.response) ? request.response.map((part: unknown) => {
      const chunk = object(part)
      if (chunk.kind !== undefined && chunk.kind !== 'markdownContent') return ''
      return typeof chunk.value === 'string' ? chunk.value : typeof object(chunk.content).value === 'string' ? String(object(chunk.content).value) : ''
    }).filter(Boolean).join('\n\n') : ''
    if (response.trim()) messages.push({ id: `vscode-assistant-${index}`, role: 'assistant', text: response, status: 'complete' })
  }
  const title = typeof snapshot.customTitle === 'string' ? snapshot.customTitle
    : messages.find((message) => message.role === 'user')?.text.split('\n')[0] ?? 'VS Code conversation'
  return { title: title.slice(0, 160), messages }
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

export class VSCodeSessionStore {
  private readonly roots: string[]
  private readonly files = new Map<string, { file: string; summary: LocalSessionSummary }>()

  constructor(roots = defaultVSCodeRoots()) { this.roots = roots }

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
            const parsed = parseVSCodeSession(await readBounded(file), entry.name.endsWith('.jsonl'))
            if (!parsed.messages.length) continue
            const id = `vscode:${rootIndex}:${workspace.name}:${entry.name}`
            const summary: LocalSessionSummary = { id, source: 'vscode', title: parsed.title, workingDirectory,
              updatedAt: (await stat(file)).mtime.toISOString(), messageCount: parsed.messages.length }
            sessions.push(summary)
            this.files.set(id, { file, summary })
          } catch {
            warnings.push(`Skipped an unreadable VS Code conversation: ${entry.name}`)
          }
        }
      }
    }
    return { sessions: sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), warnings }
  }

  async read(id: string): Promise<SessionSnapshot> {
    const entry = this.files.get(id)
    if (!entry) throw new Error('Conversation is no longer listed. Refresh the session list.')
    const parsed = parseVSCodeSession(await readBounded(entry.file), entry.file.endsWith('.jsonl'))
    return { session: entry.summary, messages: parsed.messages }
  }
}