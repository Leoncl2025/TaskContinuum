import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readJsonBounded, writeJsonAtomic } from '../src/main/shared/storage'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function file() {
  const root = await mkdtemp(join(tmpdir(), 'taskcon-storage-'))
  roots.push(root)
  return { root, path: join(root, 'state.json') }
}

it('atomically retains structured configuration without temporary files', async () => {
  const { root, path } = await file()
  await writeJsonAtomic(path, { revision: 1 })
  await writeJsonAtomic(path, { revision: 2 })
  expect(await readJsonBounded(path)).toEqual({ revision: 2 })
  expect(await readdir(root)).toEqual(['state.json'])
  expect(await readFile(path, 'utf8')).toBe('{\n  "revision": 2\n}\n')
})

it('never replaces an existing identity through an exclusive write', async () => {
  const { path } = await file()
  await writeJsonAtomic(path, { identity: 'original' }, true)
  await expect(writeJsonAtomic(path, { identity: 'replacement' }, true)).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readJsonBounded(path)).toEqual({ identity: 'original' })
})

it('surfaces malformed and oversized saved data instead of defaulting', async () => {
  const { path } = await file()
  await writeFile(path, '{invalid')
  await expect(readJsonBounded(path)).rejects.toThrow()
  await writeJsonAtomic(path, { value: 'too large' })
  await expect(readJsonBounded(path, 4)).rejects.toThrow('size limit')
})
