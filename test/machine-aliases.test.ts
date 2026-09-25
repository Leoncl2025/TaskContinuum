import { describe, expect, it } from 'vitest'
import { machineAliasMaxLength, machineDisplayName } from '../src/shared/machineAliases'
import { machineAliasChangeSchema, machineAliasSchema } from '../src/main/remoteConfig/machineAlias'

describe('machine display metadata', () => {
  it('uses stable owner IDs rather than matching hostnames or pairing IDs', () => {
    const owner = { clientId: 'owner-a', machineName: 'Same-Hostname' }
    const aliases = { 'owner-a': 'Office', 'owner-b': 'Laptop', 'pair-a': 'Wrong pairing key', 'Same-Hostname': 'Wrong hostname key' }
    expect(machineDisplayName(owner, aliases)).toBe('Office')
    expect(machineDisplayName({ ...owner, clientId: 'owner-b' }, aliases)).toBe('Laptop')
    expect(machineDisplayName({ machineName: owner.machineName }, aliases)).toBe(owner.machineName)
    expect(machineDisplayName({ ...owner, clientId: 'unknown-owner' }, aliases)).toBe(owner.machineName)
    expect(machineDisplayName(owner, {})).toBe(owner.machineName)
    expect(owner).toEqual({ clientId: 'owner-a', machineName: 'Same-Hostname' })
  })

  it.each(['constructor', '__proto__', 'toString'])('does not interpret inherited object properties as aliases (%s)', (clientId) => {
    expect(machineDisplayName({ clientId, machineName: 'Original-Hostname' }, {})).toBe('Original-Hostname')
  })

  it('accepts exactly the display length limit after trimming and rejects longer aliases', () => {
    const alias = 'a'.repeat(machineAliasMaxLength)
    expect(machineAliasSchema.parse(`  ${alias}  `)).toBe(alias)
    expect(() => machineAliasSchema.parse(`${alias}a`)).toThrow('at most 80')
    expect(machineAliasSchema.parse(' \u529e\u516c\u5ba4 laptop ')).toBe('\u529e\u516c\u5ba4 laptop')
  })

  it('distinguishes clear requests from immutable set values', () => {
    expect(machineAliasChangeSchema.parse(null)).toBeNull()
    expect(machineAliasChangeSchema.parse('   ')).toBeNull()
    expect(() => machineAliasSchema.parse('   ')).toThrow('must not be empty')
    for (const alias of ['Name\n', '\tName', 'Name\r\n', 'Name\0', 'Name\u007f', 'Name\u0085', 'Name\u2028', 'Name\u2029']) {
      expect(() => machineAliasChangeSchema.parse(alias)).toThrow('single-line')
    }
  })
})
