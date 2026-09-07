import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, open, realpath, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { CopilotService } from '../copilotService'
import type { SharedEnrollment, SharedGrant, SharedSessionDescriptor } from '../../shared/sharedSessions'
import { actorSchema, descriptorSchema, enrollmentSchema, grantSchema, permissionsSchema } from './schemas'
import { SharedSessionHost } from './host'
import { SharedJournal } from './journal'
import { startSharedServer } from './server'
import { cleanCodeReference, createSharedCheckpoint } from './checkpoint'
import { readJsonBounded, writeJsonAtomic } from './storage'

export const hostConfigSchema = z.object({
  schemaVersion: z.literal(1), session: descriptorSchema, workingDirectory: z.string().min(1).max(4096),
  model: z.string().max(200).optional(), port: z.number().int().min(1024).max(65535).optional(),
  initialContext: z.string().max(80000).optional(),
  seedHistory: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(200000) })).max(500).optional(),
}).strict()
export type HostConfiguration = z.infer<typeof hostConfigSchema>
const enrollRequest = z.object({ actor: actorSchema.extend({ kind: z.literal('user') }), permissions: permissionsSchema, host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,149}$/) }).strict()

export async function runSharedDaemon(configFile: string): Promise<void> {
  const directory = dirname(configFile)
  let config = hostConfigSchema.parse(await readJsonBounded(configFile, 2 * 1024 * 1024))
  const lockFile = join(directory, 'host.lock')
  const lock = await open(lockFile, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') throw new Error('This shared Host is already running or has a stale host.lock. Confirm the old process has exited before clearing the lock.')
    throw error
  })
  await lock.writeFile(JSON.stringify({ pid: process.pid }))
  const service = new CopilotService({ workingDirectory: config.workingDirectory })
  let host: SharedSessionHost | undefined
  let server: Awaited<ReturnType<typeof startSharedServer>> | undefined
  let workspaceLock: Awaited<ReturnType<typeof open>> | undefined
  let workspaceLockFile: string | undefined
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    try { await server?.close(); await host?.close(); await service.disconnect() } finally {
      await lock.close()
      await rm(lockFile, { force: true })
      if (workspaceLock) { await workspaceLock.close(); await rm(workspaceLockFile!, { force: true }) }
    }
  }
  try {
    const workingDirectory = await realpath(config.workingDirectory)
    const identity = process.platform === 'win32' ? workingDirectory.toLowerCase() : workingDirectory
    const locks = join(dirname(directory), '.execution-locks')
    await mkdir(locks, { recursive: true })
    workspaceLockFile = join(locks, `${createHash('sha256').update(identity).digest('hex')}.lock`)
    workspaceLock = await open(workspaceLockFile, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw new Error('Another shared Host owns this execution directory. Stop it or select an independent checkout.')
      throw error
    })
    await workspaceLock.writeFile(JSON.stringify({ pid: process.pid, sessionId: config.session.id }))
    const connected = await service.connect()
    if (connected.state !== 'ready') throw new Error(connected.error ?? 'The owner machine must sign in to Copilot before starting a Host.')
    const previousId = config.session.owner.nativeSessionId
    const previousJournal = new SharedJournal(join(directory, 'events.jsonl'), config.session)
    await previousJournal.load()
    const hasUserWork = previousJournal.snapshot().some((event) => event.type === 'message' || event.type === 'started')
    const nativeOptions = { workingDirectory: config.workingDirectory, model: config.model }
    const native = previousId === 'pending' ? await service.createSession(nativeOptions) : await service.restoreOwnedSession(previousId, nativeOptions, !hasUserWork)
    const session: SharedSessionDescriptor = { ...config.session, owner: { ...config.session.owner, nativeSessionId: native.session.id } }
    config = { ...config, session }
    await writeJsonAtomic(configFile, config)
    host = new SharedSessionHost(session, new SharedJournal(join(directory, 'events.jsonl'), session), service, config.initialContext)
    await host.start()
    if (!host.journal.lastSeq) {
      const history = config.seedHistory ?? native.messages.map(({ role, text }) => ({ role, text }))
      if (history.length > 500) throw new Error('Native history exceeds the initial sharing limit. Use a reviewed checkpoint instead.')
      for (const message of history) await host.journal.append({ type: 'history', actor: { kind: message.role === 'user' ? 'host' : 'agent', id: session.owner.agentId, name: message.role === 'user' ? 'Previous participant' : 'GitHub Copilot', machineId: session.owner.machineId, machineName: session.owner.machineName }, role: message.role, text: message.text })
    }
    const getGrants = async () => z.array(grantSchema).max(100).parse(await readJsonBounded(join(directory, 'grants.json')))
    let updating = Promise.resolve()
    server = await startSharedServer({
      host, getGrants,
      checkpoint: () => host!.freeze(async (events) => {
        const code = await cleanCodeReference(config.workingDirectory)
        return createSharedCheckpoint(session, events, code)
      }),
      enroll: (_manager, value) => {
        const request = enrollRequest.parse(value)
        const work = updating.then(async () => {
          const grants = await getGrants()
          if (grants.length >= 100) throw new Error('The participant limit was reached.')
          const token = randomBytes(32).toString('base64url')
          const grant: SharedGrant = { id: randomUUID(), actor: request.actor, permissions: [...new Set(['read' as const, ...request.permissions.filter((permission) => permission !== 'manage')])], tokenHash: createHash('sha256').update(token).digest('hex') }
          await writeJsonAtomic(join(directory, 'grants.json'), [...grants, grant])
          return enrollmentSchema.parse({ schemaVersion: 1, session, actor: grant.actor, permissions: grant.permissions, token, endpoint: { kind: 'ssh', host: request.host, remotePort: server!.port } }) satisfies SharedEnrollment
        })
        updating = work.then(() => undefined, () => undefined)
        return work
      },
      shutdown: async () => { await stop() },
    }, config.port ?? 0)
    config.port = server.port
    await writeJsonAtomic(configFile, config)
    await writeJsonAtomic(join(directory, 'status.json'), { state: 'ready', session, port: server.port, pid: process.pid })
    process.once('SIGTERM', () => { void stop() })
    process.once('SIGINT', () => { void stop() })
  } catch (error) {
    await writeJsonAtomic(join(directory, 'status.json'), { state: 'error', error: error instanceof Error ? error.message.slice(0, 2000) : 'Shared Host failed to start.' })
    await stop()
    throw error
  }
}

if (process.argv[2]) void runSharedDaemon(resolve(process.argv[2])).catch(() => { process.exitCode = 1 })