import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { devNull } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach } from 'vitest'
import { executeRepositoryCommand, WorkspaceRepositoryService } from '../src/main/workspaceRepository'
import type { RepositoryCommand, RepositoryCommandOptions, RepositoryCommandResult } from '../src/main/workspaceRepository'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

export interface RepositoryCall {
  program: 'git'
  args: string[]
  cwd: string
  timeout: number
  gitEnvironment: Record<string, string | undefined>
}

export async function repositoryFixture() {
  const root = resolve('.runtime', 'workspace-repository-tests', `case-${randomUUID()}`)
  roots.push(root)
  await mkdir(root, { recursive: true })
  const config = join(root, 'fixture-git-config')
  await writeFile(config, '[user]\n\tname = Repository Fixture\n\temail = repository-fixture@example.invalid\n')
  const calls: RepositoryCall[] = []
  const network = {
    refs: new Map<string, string>(),
    response: undefined as RepositoryCommandResult | undefined,
    before: undefined as ((call: RepositoryCall, options: RepositoryCommandOptions) => Promise<RepositoryCommandResult | void>) | undefined,
  }
  const success = (stdout = ''): RepositoryCommandResult => ({ code: 0, stdout, stderr: '' })
  const run: RepositoryCommand = async (program, args, options) => {
    const call: RepositoryCall = {
      program, args: [...args], cwd: options.cwd, timeout: options.timeout,
      gitEnvironment: Object.fromEntries(Object.entries(options.env).filter(([key]) => /^GIT_|^GCM_|^GH_(?:HOST|REPO|PROMPT_DISABLED|DEBUG)$/.test(key))),
    }
    calls.push(call)
    const intercepted = await network.before?.(call, options)
    if (intercepted) return intercepted
    if (program !== 'git') throw new Error('Only Git may be invoked by the repository service.')
    if (args.includes('ls-remote')) return network.response ?? success([...network.refs].map(([ref, head]) => `${head}\t${ref}`).join('\n'))
    if (args.some((arg) => ['push', 'fetch', 'pull', 'clone', 'credential'].includes(arg))) throw new Error('Unexpected mutating or credential/network fixture command.')
    return executeRepositoryCommand(program, args, { ...options, env: { ...options.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' } })
  }
  async function git(cwd: string, ...args: string[]): Promise<string> {
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key]
    const result = await executeRepositoryCommand('git', [
      '--no-pager', '-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false',
      '-c', `core.attributesFile=${devNull}`, '-c', `core.excludesFile=${devNull}`,
      '-c', 'commit.gpgSign=false', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
      ...args,
    ], { cwd, timeout: 20000, env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' } })
    if (result.code !== 0) throw new Error(`Fixture git ${args[0]} failed: ${result.stderr}`)
    return result.stdout
  }
  return { root, config, calls, network, git, run, service: new WorkspaceRepositoryService(run) }
}
