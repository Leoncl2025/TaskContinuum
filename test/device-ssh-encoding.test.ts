import { createPrivateKey, createPublicKey } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import ssh2 from 'ssh2'
import { expect, it } from 'vitest'
import { encodeDeviceSshKey, newSshKeyPair } from '../src/main/devTunnel/sessionSsh'
import { sshPublicKeySchema } from '../src/main/devTunnel/protocol'

it('preserves leading-zero public key bytes in the OpenSSH private/public encoding', () => {
  let selected: KeyObject | undefined
  for (let index = 0; index < 4096; index++) {
    const seed = Buffer.alloc(32)
    seed.writeUInt32BE(index)
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' })
    if (createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32)[0] === 0) { selected = key; break }
  }
  if (!selected) throw new Error('The deterministic test set contains no leading-zero key.')
  const pair = encodeDeviceSshKey(selected)
  expect(sshPublicKeySchema.safeParse(pair.publicKey).success).toBe(true)
  const parsed = ssh2.utils.parseKey(pair.privateKey)
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('The encoded private key failed to parse.')
  expect(parsed.getPublicSSH()).toEqual(Buffer.from(pair.publicKey.split(' ')[1], 'base64'))
  expect(parsed.getPublicSSH().length).toBe(51)
  const message = Buffer.from('TaskCon encoding regression')
  const signature = parsed.sign(message)
  if (signature instanceof Error) throw signature
  expect(parsed.verify(message, signature)).toBe(true)
})

it('generates independent, parseable device identities without using the ssh2 generator', () => {
  const first = newSshKeyPair()
  const second = newSshKeyPair()
  expect(first.publicKey).not.toBe(second.publicKey)
  expect(ssh2.utils.parseKey(first.privateKey)).not.toBeInstanceOf(Error)
})
