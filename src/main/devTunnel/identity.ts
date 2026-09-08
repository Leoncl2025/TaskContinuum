import { join } from 'node:path'
import { z } from 'zod'
import ssh2 from 'ssh2'
import { readJsonBounded, writeJsonAtomic } from '../shared/storage'
import { newSshKeyPair } from './sessionSsh'
import type { SshKeyPair } from './sessionSsh'
import { sshPublicKeySchema } from './protocol'

export interface KeyProtector {
  available(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

const keySchema = z.object({ schemaVersion: z.literal(1), publicKey: sshPublicKeySchema, encryptedPrivateKey: z.string().min(1).max(16384) }).strict()

export class DeviceSshKeys {
  private readonly keys = new Map<string, Promise<SshKeyPair>>()
  constructor(private readonly directory: string, private readonly protector: KeyProtector) {}

  get(purpose: 'host' | 'client'): Promise<SshKeyPair> {
    const existing = this.keys.get(purpose)
    if (existing) return existing
    const work = this.load(purpose)
    this.keys.set(purpose, work)
    void work.catch(() => { if (this.keys.get(purpose) === work) this.keys.delete(purpose) })
    return work
  }

  private async load(purpose: 'host' | 'client'): Promise<SshKeyPair> {
    if (!this.protector.available()) throw new Error('System secure storage is unavailable. Device keys were not created or stored in plaintext.')
    const file = join(this.directory, `dev-tunnel-${purpose}-identity.json`)
    let stored: z.infer<typeof keySchema>
    try { stored = keySchema.parse(await readJsonBounded(file, 20000)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('The saved SSH device identity is invalid. It was not replaced.')
      const pair = newSshKeyPair()
      stored = { schemaVersion: 1, publicKey: pair.publicKey, encryptedPrivateKey: this.protector.encrypt(pair.privateKey).toString('base64') }
      try { await writeJsonAtomic(file, stored, true) } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure
        stored = keySchema.parse(await readJsonBounded(file, 20000))
      }
    }
    try {
      const privateKey = this.protector.decrypt(Buffer.from(stored.encryptedPrivateKey, 'base64'))
      const parsed = ssh2.utils.parseKey(privateKey)
      if (parsed instanceof Error || Array.isArray(parsed) || parsed.type !== 'ssh-ed25519' || parsed.getPublicSSH().toString('base64') !== stored.publicKey.split(' ')[1]) throw new Error('Key mismatch')
      return { publicKey: stored.publicKey, privateKey }
    } catch { throw new Error('The SSH identity cannot be unlocked in this OS profile. Restore the profile or explicitly pair a new device; the key was not replaced.') }
  }
}