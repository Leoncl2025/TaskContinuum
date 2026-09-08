// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { DeviceSshKeys } from '../src/main/devTunnel/identity'
import type { KeyProtector } from '../src/main/devTunnel/identity'
import { DevTunnelCli, parseDevTunnelJson } from '../src/main/devTunnel/cli'

describe('private device identity', () => {
  it('accepts the CLI welcome preamble without tolerating malformed or arbitrary output', () => {
    expect(parseDevTunnelJson('Welcome to dev tunnels!\r\nCLI version: 1.0\r\n\r\n{\r\n"status":"Logged in"\r\n}\r\n')).toEqual({ status: 'Logged in' })
    expect(() => parseDevTunnelJson('Unexpected message\n{"status":"Logged in"}')).toThrow()
    expect(() => parseDevTunnelJson('Welcome to dev tunnels!\n{invalid}')).toThrow()
  })

  it('persists an encrypted device key, preserves identity, and never replaces corrupt data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continuum-device-key-'))
    const secret = randomBytes(32)
    const protector: KeyProtector = {
      available: () => true,
      encrypt: (value) => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', secret, iv); const encrypted = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]) },
      decrypt: (value) => { const cipher = createDecipheriv('aes-256-gcm', secret, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString() },
    }
    try {
      const keys = new DeviceSshKeys(root, protector)
      const [first, concurrent] = await Promise.all([keys.get('client'), keys.get('client')])
      expect(first).toEqual(concurrent)
      const raw = await readFile(join(root, 'dev-tunnel-client-identity.json'), 'utf8')
      expect(raw).not.toContain('PRIVATE KEY')
      expect(raw).not.toContain(first.privateKey)
      expect(await new DeviceSshKeys(root, protector).get('client')).toEqual(first)
      expect((await keys.get('host')).publicKey).not.toBe(first.publicKey)
      await writeFile(join(root, 'dev-tunnel-client-identity.json'), 'invalid')
      await expect(new DeviceSshKeys(root, protector).get('client')).rejects.toThrow('not replaced')
      expect(await readFile(join(root, 'dev-tunnel-client-identity.json'), 'utf8')).toBe('invalid')
      await expect(new DeviceSshKeys(root, { ...protector, available: () => false }).get('host')).rejects.toThrow('plaintext')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('uses fixed private CLI operations and rejects shared tunnels and shell-like IDs', async () => {
    const run = vi.fn(async () => ({ tunnel: { tunnelId: 'taskcontinuum-abcd.jpe1', accessControl: [], hostConnections: 0 } }))
    const cli = new DevTunnelCli(run)
    const signal = new AbortController().signal
    await cli.create(`taskcontinuum-${'a'.repeat(32)}`, signal)
    expect(run).toHaveBeenCalledWith(['create', `taskcontinuum-${'a'.repeat(32)}`, '--expiration', '30d', '--json'], signal)
    await cli.inspect('taskcontinuum-abcd.jpe1', signal)
    run.mockResolvedValue({ tunnel: { tunnelId: 'taskcontinuum-abcd.jpe1', accessControl: [{ type: 'Anonymous' }], hostConnections: 0 } } as never)
    await expect(cli.inspect('taskcontinuum-abcd.jpe1', signal)).rejects.toThrow('owner-only')
    await expect(cli.inspect('-x;bad.jpe1', signal)).rejects.toThrow()
    expect(JSON.stringify(run.mock.calls)).not.toContain('allow-anonymous')
  })
})