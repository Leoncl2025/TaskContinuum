import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

export class JsonFileSizeError extends Error {
  constructor(readonly limitBytes: number, readonly actualBytes: number) {
    super('The selected data file exceeds its size limit.')
    this.name = 'JsonFileSizeError'
  }
}

export async function readJsonBounded(file: string, maximum = 1024 * 1024): Promise<unknown> {
  const handle = await open(file, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('The selected data file is not a regular file.')
    if (info.size > maximum) throw new JsonFileSizeError(maximum, info.size)
    const text = await handle.readFile('utf8')
    const bytes = Buffer.byteLength(text)
    if (bytes > maximum) throw new JsonFileSizeError(maximum, bytes)
    return JSON.parse(text) as unknown
  } finally { await handle.close() }
}

export async function writeJsonAtomic(file: string, value: unknown, exclusive = false): Promise<void> {
  return writeTextAtomic(file, JSON.stringify(value, null, 2) + '\n', exclusive)
}

export async function writeTextAtomic(file: string, text: string, exclusive = false): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  if (exclusive) {
    const handle = await open(file, 'wx', 0o600)
    try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
    return
  }
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }) }
}
