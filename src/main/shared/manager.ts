import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type { SharedActor, SharedConnectionSummary, SharedEnrollment, SharedEvent, SharedGrant, SharedSessionDescriptor, SharedView } from '../../shared/sharedSessions'
import { readTaskWorkspace } from '../workspaceReader'
import { SharedSessionClient } from './client'
import type { SharedClientUpdate } from './client'
import { actorSchema, descriptorSchema, enrollmentSchema, permissionsSchema } from './schemas'
import { localIdentity, readJsonBounded, readSharedRoutes, registerSharedRoute, writeJsonAtomic } from './storage'
import { semanticContinuation, verifyCodeReference, verifySharedCheckpoint } from './checkpoint'
import type { SharedCheckpoint } from './checkpoint'

interface LocalEnrollment { enrollment: SharedEnrollment; hostDirectory?: string }
const catalogSchema = z.array(z.object({ enrollment: enrollmentSchema, hostDirectory: z.string().optional() }).strict()).max(100)
const publishSchema = z.object({ taskId: z.string().regex(/^T-\d{4,}$/), workingDirectory: z.string().min(1).max(4096), mode: z.enum(['live', 'checkpoint']), model: z.string().max(200).optional() }).strict()
const checkpointIndexSchema = z.array(z.object({ session: descriptorSchema, checkpointId: z.uuid(), lastSeq: z.number().int().nonnegative() }).strict()).max(100)

export class SharedSessionManager {
  private catalog: LocalEnrollment[] = []
  private offlineCheckpoints: z.infer<typeof checkpointIndexSchema> = []
  private loaded = false
  private writing = Promise.resolve()
  private readonly clients = new Map<string, SharedSessionClient>()
  private readonly listeners = new Set<(id: string, update: SharedClientUpdate) => void>()
  private readonly checkpointPreviews = new Map<string, SharedCheckpoint>()

  constructor(private readonly profile: string, private readonly worker: string) {}

  private get file(): string { return join(this.profile, 'shared-enrollments.json') }
  private async load(): Promise<void> {
    if (this.loaded) return
    try { this.catalog = catalogSchema.parse(await readJsonBounded(this.file, 2 * 1024 * 1024)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    try { this.offlineCheckpoints = checkpointIndexSchema.parse(await readJsonBounded(join(this.profile, 'shared-checkpoints', 'index.json'))) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    this.loaded = true
  }
  private async save(): Promise<void> {
    const snapshot = structuredClone(this.catalog)
    const work = this.writing.then(() => writeJsonAtomic(this.file, snapshot))
    this.writing = work.catch(() => undefined)
    await work
  }
  onUpdate(listener: (id: string, update: SharedClientUpdate) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  async identity(): Promise<SharedActor> { return localIdentity(this.profile) }

  async list(root: string): Promise<SharedConnectionSummary[]> {
    await this.load()
    const routes = await readSharedRoutes(root)
    if (!routes) return []
    const enrolled = this.catalog.filter((item) => item.enrollment.session.workspaceId === routes.workspaceId).map(({ enrollment }) => ({ id: enrollment.session.id, workspaceId: enrollment.session.workspaceId, taskId: enrollment.session.taskId, owner: enrollment.session.owner.machineName, machine: enrollment.actor.machineName, mode: enrollment.session.mode, parentSessionId: enrollment.session.parent?.sessionId }))
    return [...enrolled, ...this.offlineCheckpoints.filter((item) => item.session.workspaceId === routes.workspaceId && !enrolled.some((entry) => entry.id === item.session.id)).map(({ session }) => ({ id: session.id, workspaceId: session.workspaceId, taskId: session.taskId, owner: session.owner.machineName, machine: 'Checkpoint copy', mode: session.mode, parentSessionId: session.parent?.sessionId }))]
  }

  private async client(id: string): Promise<SharedSessionClient> {
    await this.load()
    const entry = this.catalog.find((item) => item.enrollment.session.id === id)
    if (!entry) throw new Error('Enroll in this shared session before opening it.')
    let client = this.clients.get(id)
    if (!client) {
      client = new SharedSessionClient(entry.enrollment, join(this.profile, 'shared-cache', `${id}.jsonl`))
      client.onUpdate((update) => { for (const listener of this.listeners) listener(id, update) })
      this.clients.set(id, client)
    }
    await client.load()
    return client
  }

  private async checkpointView(id: string): Promise<SharedView | undefined> {
    await this.load()
    if (this.catalog.some((entry) => entry.enrollment.session.id === id)) return undefined
    const entry = this.offlineCheckpoints.find((item) => item.session.id === id)
    if (!entry) return undefined
    const saved = verifySharedCheckpoint(await readJsonBounded(join(this.profile, 'shared-checkpoints', `${entry.checkpointId}.json`), 16 * 1024 * 1024))
    return { session: saved.payload.session, events: saved.payload.events, online: false, actor: await this.identity(), permissions: ['read'], checkpoint: { id: saved.payload.checkpointId, commit: saved.payload.code.commit, createdAt: saved.payload.createdAt } }
  }
  async open(id: string): Promise<SharedView> { return await this.checkpointView(id) ?? (await this.client(id)).connect() }
  async cached(id: string): Promise<SharedView> { return await this.checkpointView(id) ?? (await this.client(id)).view }
  async disconnect(id: string): Promise<void> { await this.clients.get(id)?.disconnect() }
  async send(id: string, commandId: string, text: string): Promise<void> { await (await this.client(id)).command(commandId, text) }
  async stop(id: string, commandId: string): Promise<void> { await (await this.client(id)).stop(commandId) }
  async respond(id: string, interactionId: string, answer: boolean | string): Promise<void> { await (await this.client(id)).respond(interactionId, answer) }

  private async remember(enrollment: SharedEnrollment, hostDirectory?: string): Promise<void> {
    await this.load()
    if (this.catalog.some((item) => item.enrollment.session.id === enrollment.session.id)) throw new Error('This logical session is already enrolled on this desktop.')
    this.catalog.push({ enrollment, hostDirectory })
    try { await this.save() } catch (error) { this.catalog.pop(); throw error }
  }

  async publish(root: string, value: unknown, checkpoint?: SharedCheckpoint): Promise<SharedView> {
    const request = publishSchema.parse(value)
    const workspace = await readTaskWorkspace(root)
    if (!workspace.tasks.some((task) => task.id === request.taskId)) throw new Error('Choose a valid task before publishing a shared session.')
    const routes = await readSharedRoutes(root)
    if (!checkpoint && routes?.active[request.taskId]) throw new Error('This task already has a published shared session. Open its enrollment or use an explicit checkpoint fork.')
    if (checkpoint && checkpoint.payload.session.taskId !== request.taskId) throw new Error('Checkpoint task mismatch.')
    const actor = await this.identity()
    const session: SharedSessionDescriptor = {
      schemaVersion: 1, id: randomUUID(), workspaceId: routes?.workspaceId ?? checkpoint?.payload.session.workspaceId ?? randomUUID(), taskId: request.taskId,
      mode: request.mode, createdAt: new Date().toISOString(), owner: { machineId: actor.machineId, machineName: actor.machineName, agentId: randomUUID(), nativeSessionId: 'pending', epoch: 1 },
      ...(checkpoint ? { parent: { sessionId: checkpoint.payload.session.id, checkpointId: checkpoint.payload.checkpointId, mode: 'semantic' as const } } : {}),
    }
    if (checkpoint && session.workspaceId !== checkpoint.payload.session.workspaceId) throw new Error('Open the checkpoint task repository before creating a fork.')
    const token = randomBytes(32).toString('base64url')
    const grant: SharedGrant = { id: randomUUID(), actor, permissions: ['read', 'send', 'approve', 'stop', 'checkpoint', 'manage'], tokenHash: createHash('sha256').update(token).digest('hex') }
    const directory = join(this.profile, 'shared-hosts', session.id)
    await mkdir(directory, { recursive: true })
    await writeJsonAtomic(join(directory, 'grants.json'), [grant], true)
    await writeJsonAtomic(join(directory, 'host.json'), { schemaVersion: 1, session, workingDirectory: request.workingDirectory, model: request.model, ...(checkpoint ? { initialContext: semanticContinuation(checkpoint), seedHistory: [{ role: 'assistant', text: checkpoint.payload.context }] } : {}) }, true)
    await this.startProcess(directory)
    const status = z.object({ state: z.literal('ready'), session: descriptorSchema, port: z.number().int().min(1024).max(65535) }).parse(await readJsonBounded(join(directory, 'status.json')))
    const enrollment: SharedEnrollment = { schemaVersion: 1, session: status.session, actor, permissions: grant.permissions, token, endpoint: { kind: 'local', port: status.port } }
    await this.remember(enrollment, directory)
    try { await registerSharedRoute(root, status.session, !checkpoint) } catch (error) {
      const client = await this.client(session.id)
      await client.connect()
      await client.stopHost().catch(() => undefined)
      throw error
    }
    return this.open(session.id)
  }

  private async startProcess(directory: string): Promise<void> {
    const lock = await lstat(join(directory, 'host.lock')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (lock) throw new Error('The Host is running or has an uncleared crash lock. Confirm it stopped before recovery; no lock was removed automatically.')
    await rm(join(directory, 'status.json'), { force: true })
    const env = { ...process.env }
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
    const child = spawn(process.execPath, [this.worker, join(directory, 'host.json')], { detached: true, windowsHide: true, stdio: 'ignore', env, cwd: dirname(this.worker) })
    let failure: Error | undefined
    child.on('error', () => { failure = new Error('The independent shared Host could not start.') })
    child.on('exit', (code) => { if (code !== 0) failure = new Error('The independent Host exited before it was ready. Review its local status file.') })
    child.unref()
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      if (failure) throw failure
      try {
        const status = await readJsonBounded(join(directory, 'status.json')) as { state?: string; error?: string }
        if (status.state === 'ready') return
        if (status.state === 'error') throw new Error(status.error ?? 'Shared Host failed to initialize.')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      await new Promise<void>((resolve) => setTimeout(resolve, 150))
    }
    child.kill()
    throw new Error('Shared Host startup timed out. Verify local Copilot authentication and retry.')
  }

  async importEnrollment(root: string, file: string): Promise<SharedView> {
    const enrollment = enrollmentSchema.parse(await readJsonBounded(file))
    const workspace = await readTaskWorkspace(root)
    if (!workspace.tasks.some((task) => task.id === enrollment.session.taskId)) throw new Error('The enrollment task does not exist in this workspace.')
    const identity = await this.identity()
    if (enrollment.actor.id !== identity.id || enrollment.actor.machineId !== identity.machineId) throw new Error('This enrollment is issued to a different user or machine. Share this desktop identity with the Host owner to request a matching invitation.')
    await registerSharedRoute(root, enrollment.session, false)
    await this.remember(enrollment)
    return this.open(enrollment.session.id)
  }

  async invite(id: string, value: unknown): Promise<SharedEnrollment> {
    const input = z.object({ actor: actorSchema.extend({ kind: z.literal('user') }), permissions: permissionsSchema, host: z.string() }).parse(value)
    return enrollmentSchema.parse(await (await this.client(id)).enroll(input))
  }

  async checkpoint(id: string): Promise<SharedCheckpoint> { return verifySharedCheckpoint(await (await this.client(id)).checkpoint()) }
  async previewCheckpoint(file: string): Promise<{ token: string; checkpoint: SharedCheckpoint }> {
    const checkpoint = verifySharedCheckpoint(await readJsonBounded(file, 16 * 1024 * 1024))
    if (this.checkpointPreviews.size > 4) this.checkpointPreviews.clear()
    const token = randomUUID()
    this.checkpointPreviews.set(token, checkpoint)
    return { token, checkpoint }
  }
  async keepCheckpoint(root: string, token: string): Promise<SharedView> {
    const checkpoint = this.checkpointPreviews.get(token)
    if (!checkpoint) throw new Error('Review the checkpoint before saving an offline copy.')
    await this.load()
    const workspace = await readTaskWorkspace(root)
    if (!workspace.tasks.some((task) => task.id === checkpoint.payload.session.taskId)) throw new Error('The checkpoint task is not present in this workspace.')
    const existing = this.offlineCheckpoints.find((entry) => entry.session.id === checkpoint.payload.session.id)
    if (existing && existing.lastSeq > checkpoint.payload.lastSeq) throw new Error('A newer checkpoint is already cached on this machine.')
    await registerSharedRoute(root, checkpoint.payload.session, false)
    await writeJsonAtomic(join(this.profile, 'shared-checkpoints', `${checkpoint.payload.checkpointId}.json`), checkpoint)
    const next = [...this.offlineCheckpoints.filter((entry) => entry.session.id !== checkpoint.payload.session.id), { session: checkpoint.payload.session, checkpointId: checkpoint.payload.checkpointId, lastSeq: checkpoint.payload.lastSeq }]
    await writeJsonAtomic(join(this.profile, 'shared-checkpoints', 'index.json'), checkpointIndexSchema.parse(next))
    this.offlineCheckpoints = next
    this.checkpointPreviews.delete(token)
    if (this.catalog.some((entry) => entry.enrollment.session.id === checkpoint.payload.session.id)) {
      const client = await this.client(checkpoint.payload.session.id)
      for (const event of checkpoint.payload.events) await client.journal.accept(event)
      return client.view
    }
    return (await this.checkpointView(checkpoint.payload.session.id))!
  }
  async fork(root: string, token: string, workingDirectory: string): Promise<SharedView> {
    const checkpoint = this.checkpointPreviews.get(token)
    if (!checkpoint) throw new Error('Review the checkpoint before creating a continuation fork.')
    await verifyCodeReference(workingDirectory, checkpoint.payload.code.commit)
    await this.load()
    for (const entry of this.catalog) {
      if (!entry.hostDirectory) continue
      const config = await readJsonBounded(join(entry.hostDirectory, 'host.json')) as { workingDirectory?: unknown }
      if (typeof config.workingDirectory === 'string' && resolve(workingDirectory).toLowerCase() === resolve(config.workingDirectory).toLowerCase()) {
        throw new Error('Use an independent clean clone for this fork, not a workspace assigned to an existing local Host.')
      }
    }
    this.checkpointPreviews.delete(token)
    return this.publish(root, { taskId: checkpoint.payload.session.taskId, workingDirectory, mode: 'checkpoint' }, checkpoint)
  }

  async stopOwner(id: string): Promise<void> { await (await this.client(id)).stopHost(); await (await this.client(id)).disconnect() }
  async restartOwner(root: string, id: string): Promise<SharedView> {
    await this.load()
    const entry = this.catalog.find((item) => item.enrollment.session.id === id)
    const identity = await this.identity()
    if (!entry?.hostDirectory || entry.enrollment.session.owner.machineId !== identity.machineId || !entry.enrollment.permissions.includes('manage')) {
      throw new Error('Only the original owner machine can restart this Host. Other machines must use a reviewed checkpoint fork.')
    }
    const routes = await readSharedRoutes(root)
    if (!routes?.sessions.some((session) => session.id === id)) throw new Error('The shared Host is not part of the selected workspace.')
    const current = await (await this.client(id)).connect()
    if (current.online) return current
    await this.startProcess(entry.hostDirectory)
    return this.open(id)
  }
  async close(): Promise<void> { await Promise.all([...this.clients.values()].map((client) => client.disconnect())) }
  async events(id: string): Promise<SharedEvent[]> { return (await this.client(id)).view.events }
}