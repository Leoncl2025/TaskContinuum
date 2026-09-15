import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function readJsonBounded(file: string, maximum = 1024 * 1024): Promise<unknown> {
  const handle = await open(file, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maximum) throw new Error('The selected data file exceeds its size limit.')
    const text = await handle.readFile('utf8')
    if (Buffer.byteLength(text) > maximum) throw new Error('The selected data file exceeds its size limit.')
    return JSON.parse(text) as unknown
  } finally { await handle.close() }
}

export async function writeJsonAtomic(file: string, value: unknown, exclusive = false): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  if (exclusive) {
    const handle = await open(file, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync() } finally { await handle.close() }
    return
  }
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync() } finally { await handle.close() }
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }) }
}
