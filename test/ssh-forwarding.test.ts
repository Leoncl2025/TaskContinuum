import { expect, it } from 'vitest'
import { sshArguments } from '../src/main/shared/ssh'

it('keeps native AHP test forwarding noninteractive, loopback-only and host-key checked', () => {
  const args = sshArguments('owner-machine', 24001, 24002)
  expect(args).toEqual([
    '-N', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2', '-L', '127.0.0.1:24001:127.0.0.1:24002', '--', 'owner-machine',
  ])
})

it('rejects commands, invalid ports and relative SSH configuration paths', () => {
  for (const host of ['-oProxyCommand=run', 'host name', 'host;command']) {
    expect(() => sshArguments(host, 24001, 24002)).toThrow()
  }
  expect(() => sshArguments('owner', 80, 24002)).toThrow()
  expect(() => sshArguments('owner', 24001, 65536)).toThrow()
  expect(() => sshArguments('owner', 24001, 24002, 'relative-config')).toThrow()
})
