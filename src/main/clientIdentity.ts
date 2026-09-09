import { randomUUID } from 'node:crypto'
import { hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'
import { remoteClientSchema } from './vscodeRemoteProtocol'

export async function readClientIdentity(directory: string) {
  const file = join(directory, 'remote-vscode-identity.json')
  const schema = z.object({ clientId: z.uuid() }).strict()
  let saved: z.infer<typeof schema>
  try { saved = schema.parse(await readJsonBounded(file, 1024)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    saved = { clientId: randomUUID() }
    try { await writeJsonAtomic(file, saved, true) } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure
      saved = schema.parse(await readJsonBounded(file, 1024))
    }
  }
  return remoteClientSchema.parse({ ...saved, username: userInfo().username, machineName: hostname() })
}