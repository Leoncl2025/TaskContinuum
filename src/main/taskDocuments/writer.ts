// Adapted from AgentDesk 0cabc9faf70cc482de4fd94a31e0a281ec9a6e83 (MIT). See THIRD_PARTY_NOTICES.md.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { type HistoryEntry, Task } from '../../shared/taskDocuments/task.js'
import { DocumentFiles } from './files.js'
import { hashOf } from './hash.js'
import { validateDocuments } from './validation.js'

export class ConflictError extends Error {
  readonly actualHash: string
  constructor(actualHash: string) {
    super('File was modified outside the app')
    this.name = 'ConflictError'
    this.actualHash = actualHash
  }
}

const PATCHABLE = new Set([
  'status', 'priority', 'owner', 'driver', 'size', 'sprint', 'tags', 'assignees',
  'title', 'summary', 'dates.due', 'dates.started', 'dates.completed',
  'effort.estimateHours', 'effort.spentHours', 'today.date', 'today.focus',
  'today.nextAction', 'today.timeboxHours', 'progress.mode', 'progress.manualPercent',
  'relations.parent', 'relations.dependsOn', 'copilot.handoff', 'copilot.phase',
  'copilot.contextScope',
])

/**
 * Narrow document write gate, not an IPC endpoint. Validates an in-memory overlay,
 * then replaces exactly one owner file, preserving raw fields, order and EOL.
 */
export function patchTaskFields(
  root: string,
  dir: string,
  patch: Record<string, unknown>,
  options: { actor: string; expectedHash: string; note?: string },
): { hash: string; changed: HistoryEntry[] } {
  if (!options.expectedHash) throw new Error('An expected content hash is required.')
  const files = new DocumentFiles(root)
  const file = files.contained(path.join(files.root, dir, 'task.json'))
  const originalText = files.readFileSync(file, 'utf8')
  const hash = hashOf(originalText)
  if (hash !== options.expectedHash) throw new ConflictError(hash)
  const original: unknown = JSON.parse(originalText)
  const current = Task.parse(original)
  const initial = validateDocuments(files.root, undefined, files)
  const loaded = initial.workspace.tasks.filter((task) => !task.broken && task.task.id === current.id)
  if (loaded.length !== 1 || path.resolve(files.root, loaded[0].dir, 'task.json') !== file) {
    throw new Error('The target must be a unique task in the configured workspace.')
  }
  const next = JSON.parse(originalText) as Record<string, unknown>
  const changed: HistoryEntry[] = []
  const at = new Date().toISOString()
  for (const [field, value] of Object.entries(patch)) {
    if (!PATCHABLE.has(field)) throw new Error(`Field ${field} is read-only or is not in the writable allow-list.`)
    const parts = field.split('.')
    let owner = next
    for (const key of parts.slice(0, -1)) {
      const existing = owner[key]
      if (existing === undefined || existing === null) owner[key] = {}
      else if (typeof existing !== 'object' || Array.isArray(existing)) throw new Error(`Cannot update ${field}.`)
      owner = owner[key] as Record<string, unknown>
    }
    const key = parts[parts.length - 1]
    const before = owner[key]
    if (JSON.stringify(before) === JSON.stringify(value)) continue
    if (value === undefined) throw new Error('Use explicit null rather than undefined for field updates.')
    owner[key] = value
    changed.push({
      at, by: options.actor, field, from: scalar(before), to: scalar(value),
      ...(options.note ? { note: options.note } : {}),
    })
  }
  if (!changed.length) return { hash, changed }
  next.history = [...(Array.isArray(next.history) ? next.history : []), ...changed]
  // Check raw data, but do not serialize parsed defaults or strip unrelated fields.
  Task.parse(next)
  const eol = originalText.includes('\r\n') ? '\r\n' : '\n'
  const content = `${JSON.stringify(next, null, 2)}\n`.replace(/\n/g, eol)
  if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('Updated task exceeds the 1 MB file limit.')
  const overlayBytes = [...files.texts.values()].reduce((total, text) => total + Buffer.byteLength(text), 0) -
    Buffer.byteLength(originalText) + Buffer.byteLength(content)
  if (overlayBytes > 16 * 1024 * 1024) throw new Error('Updated workspace exceeds the 16 MB read limit.')
  const baselineErrors = new Set(initial.issues.filter((item) => item.severity === 'error').map((item) => JSON.stringify(item)))
  files.texts.set(file, content)
  const validated = validateDocuments(files.root, undefined, files)
  const errors = validated.issues.filter((item) => item.severity === 'error' &&
    (!item.taskId || item.taskId === current.id || item.path === dir || item.path === path.join(dir, 'task.json') ||
      item.related?.includes(current.id) || !baselineErrors.has(JSON.stringify(item))))
  if (errors.length) throw new Error(`Update rejected: ${errors.map((item) => `${item.code}: ${item.message}`).join('; ')}`)
  const staging = `${file}.${randomUUID()}.staging`
  try {
    files.contained(file)
    fs.writeFileSync(staging, content, { encoding: 'utf8', flag: 'wx' })
    // A fresh read bypasses the validation snapshot and catches concurrent edits.
    const actualHash = hashOf(new DocumentFiles(files.root).readFileSync(file, 'utf8'))
    if (actualHash !== options.expectedHash) throw new ConflictError(actualHash)
    files.contained(file)
    fs.renameSync(staging, file)
  } finally {
    if (fs.existsSync(staging)) fs.unlinkSync(staging)
  }
  return { hash: hashOf(content), changed }
}

function scalar(value: unknown): string | number | boolean | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return JSON.stringify(value)
}
