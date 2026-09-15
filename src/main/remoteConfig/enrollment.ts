import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { sshFingerprint, sshPublicKeySchema } from '../devTunnel/protocol'
import { canonicalPolicyRoot } from '../linkedSessionPolicy'
import { readJsonBounded, writeJsonAtomic } from '../shared/storage'

const pinSchema = z.object({
  clientPublicKey: sshPublicKeySchema,
  hostPublicKey: sshPublicKeySchema,
  blocked: z.boolean(),
  acceptedOperations: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10000).optional(),
}).strict()
const enrollmentSchema = z.object({
  root: z.string().min(1).max(4096),
  workspaceId: z.uuid(),
  enabled: z.boolean(),
  admitNewDevices: z.boolean(),
  pins: z.record(z.uuid(), pinSchema),
}).strict()
const enrollmentsSchema = z.object({ schemaVersion: z.literal(1), workspaces: z.array(enrollmentSchema).max(10) }).strict()
export type WorkspaceEnrollment = z.infer<typeof enrollmentSchema>

export function initialWorkspaceId(remote: string, branch: string): string {
  const hex = createHash('sha256').update(JSON.stringify(['TaskCon.Workspace.v1', remote, branch])).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export class LocalEnrollments {
  private readonly file: string
  private pending: Promise<unknown> = Promise.resolve()

  constructor(directory: string) { this.file = join(directory, 'git-workspace-enrollments.json') }

  private storedRoot(root: string): string {
    if (!isAbsolute(root)) throw new Error('An enrolled workspace root must be absolute.')
    const path = resolve(root)
    return process.platform === 'win32' ? path.toLowerCase() : path
  }

  private async read(): Promise<WorkspaceEnrollment[]> {
    try {
      return enrollmentsSchema.parse(await readJsonBounded(this.file, 8 * 1024 * 1024)).workspaces
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error('Saved Git enrollment is invalid. It was not reset or replaced.', { cause: error })
    }
  }

  private update<T>(action: (rows: WorkspaceEnrollment[]) => T | Promise<T>): Promise<T> {
    const operation = this.pending.then(async () => {
      const rows = await this.read()
      const result = await action(rows)
      const document = enrollmentsSchema.parse({ schemaVersion: 1, workspaces: rows })
      if (Buffer.byteLength(JSON.stringify(document, null, 2)) >= 8 * 1024 * 1024) throw new Error('Local enrollment state exceeds its size limit. Existing trust was retained.')
      await writeJsonAtomic(this.file, document)
      return result
    })
    this.pending = operation.then(() => undefined, () => undefined)
    return operation
  }

  async list(): Promise<WorkspaceEnrollment[]> { await this.pending; return this.read() }

  async get(root: string): Promise<WorkspaceEnrollment | undefined> {
    const canonical = await canonicalPolicyRoot(root)
    return (await this.list()).find((row) => row.root === canonical)
  }

  async enable(root: string, workspaceId: string, admitNewDevices: boolean): Promise<WorkspaceEnrollment> {
    const canonical = await canonicalPolicyRoot(root)
    z.uuid().parse(workspaceId)
    return this.update((rows) => {
      let row = rows.find((item) => item.root === canonical)
      if (row && row.workspaceId !== workspaceId) throw new Error('The enrolled workspace identity changed. Automatic synchronization is blocked.')
      if (!row) {
        if (rows.length >= 10) throw new Error('The Git enrollment limit is 10 workspaces.')
        row = { root: canonical, workspaceId, enabled: true, admitNewDevices, pins: {} }
        rows.push(row)
      } else {
        row.enabled = true
        row.admitNewDevices = admitNewDevices
      }
      return structuredClone(row)
    })
  }

  async disable(root: string): Promise<void> {
    const canonical = this.storedRoot(root)
    await this.update((rows) => {
      const row = rows.find((item) => item.root === canonical)
      if (!row) throw new Error('This workspace is not enrolled for Git synchronization.')
      row.enabled = false
    })
  }

  async admit(root: string, deviceId: string, clientPublicKey: string, hostPublicKey: string, explicitlyTrusted = false): Promise<void> {
    const canonical = await canonicalPolicyRoot(root)
    z.uuid().parse(deviceId)
    sshPublicKeySchema.parse(clientPublicKey)
    sshPublicKeySchema.parse(hostPublicKey)
    await this.update((rows) => {
      const row = rows.find((item) => item.root === canonical)
      if (!row?.enabled) throw new Error('The workspace enrollment is disabled.')
      const pin = row.pins[deviceId]
      if (!pin && Object.values(row.pins).some((existing) => existing.clientPublicKey === clientPublicKey || existing.hostPublicKey === hostPublicKey)) {
        throw new Error('This SSH identity is already bound to an enrolled device. A different device ID cannot bypass that identity or its revocation.')
      }
      if (pin?.blocked) throw new Error('This device was revoked locally. Repository publication cannot reinstate it.')
      if (pin && (pin.clientPublicKey !== clientPublicKey || pin.hostPublicKey !== hostPublicKey)) {
        throw new Error(`The SSH identity changed for ${deviceId}. Verify the new key and reenroll explicitly.`)
      }
      if (!pin && !explicitlyTrusted && !row.admitNewDevices) throw new Error(`Device ${deviceId} awaits local enrollment trust.`)
      if (!pin && Object.keys(row.pins).length >= 32) throw new Error('The enrolled workspace device limit is 32.')
      row.pins[deviceId] = { clientPublicKey, hostPublicKey, blocked: false }
    })
  }

  async revoke(root: string, deviceId: string, acceptedOperations: string[] = []): Promise<void> {
    const canonical = this.storedRoot(root)
    z.uuid().parse(deviceId)
    await this.update((rows) => {
      const row = rows.find((item) => item.root === canonical)
      if (!row?.pins[deviceId]) throw new Error('The device is not enrolled in this workspace.')
      row.pins[deviceId].blocked = true
      row.pins[deviceId].acceptedOperations = [...new Set(acceptedOperations)]
    })
  }

  async trustedKey(root: string, deviceId: string, keyId: string): Promise<string | undefined> {
    const row = await this.get(root)
    const pin = row?.pins[deviceId]
    return row?.enabled && pin && !pin.blocked && sshFingerprint(pin.clientPublicKey) === keyId ? pin.clientPublicKey : undefined
  }
}
