export const machineAliasMaxLength = 80

export function machineDisplayName(owner: { clientId?: string; machineName: string }, aliases: Readonly<Record<string, string>>): string {
  return owner.clientId && Object.hasOwn(aliases, owner.clientId) ? aliases[owner.clientId] : owner.machineName
}
