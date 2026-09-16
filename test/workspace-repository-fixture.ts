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

interface FakeRepository {
  id: number
  name: string
  full_name: string
  html_url: string
  clone_url: string
  private: boolean
  owner: { login: string }
}

export interface RepositoryCall {
  program: 'git' | 'gh'
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
  const github = {
    installed: true,
    authenticated: true,
    authError: '',
    login: 'fixture-owner',
    repository: null as FakeRepository | null,
    refs: new Map<string, string>(),
    pushFailures: 0,
    acknowledgeFailedPush: false,
    createResponse: undefined as RepositoryCommandResult | undefined,
    before: undefined as ((call: RepositoryCall, options: RepositoryCommandOptions) => Promise<RepositoryCommandResult | void>) | undefined,
  }
  const success = (stdout = ''): RepositoryCommandResult => ({ code: 0, stdout, stderr: '' })
  const run: RepositoryCommand = async (program, args, options) => {
    const call: RepositoryCall = {
      program, args: [...args], cwd: options.cwd, timeout: options.timeout,
      gitEnvironment: Object.fromEntries(Object.entries(options.env).filter(([key]) => /^GIT_|^GCM_|^GH_(?:HOST|REPO|PROMPT_DISABLED|DEBUG)$/.test(key))),
    }
    calls.push(call)
    const intercepted = await github.before?.(call, options)
    if (intercepted) return intercepted
    if (program === 'git') {
      if (args.includes('ls-remote')) return success([...github.refs].map(([ref, head]) => `${head}\t${ref}`).join('\n'))
      if (args.includes('push')) {
        const [head, ref] = args.at(-1)!.split(':')
        if (github.pushFailures > 0) {
          github.pushFailures--
          if (github.acknowledgeFailedPush) github.refs.set(ref, head)
          return { code: 1, stdout: '', stderr: 'Simulated network failure; no actual network request.' }
        }
        github.refs.set(ref, head)
        return success('Simulated successful push; no actual network request.')
      }
      return executeRepositoryCommand(program, args, { ...options, env: { ...options.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' } })
    }
    if (!github.installed) throw Object.assign(new Error('GitHub CLI fixture is unavailable.'), { code: 'ENOENT' })
    if (args[0] === '--version') return success('gh fixture-version')
    if (args[0] === 'auth') return github.authError ? { code: 1, stdout: '', stderr: github.authError }
      : github.authenticated ? success('Signed in to the fixture account.') : { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts. Run gh auth login.' }
    if (args[0] === 'api' && args.includes('user')) return success(github.login)
    if (args[0] === 'api' && args.some((arg) => arg.startsWith('repos/'))) return github.repository ? success(JSON.stringify(github.repository))
      : { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
    if (args[0] === 'api' && args.includes('user/repos') && args.includes('POST')) {
      if (github.createResponse) return github.createResponse
      if (github.repository) throw new Error('A test attempted duplicate remote creation.')
      const name = args.find((arg) => arg.startsWith('name='))!.slice('name='.length)
      const fullName = `${github.login}/${name}`
      github.repository = {
        id: 12345, name, full_name: fullName, html_url: `https://github.com/${fullName}`,
        clone_url: `https://github.com/${fullName}.git`, private: args.includes('private=true'), owner: { login: github.login },
      }
      return success(JSON.stringify(github.repository))
    }
    throw new Error(`Unexpected GitHub CLI fixture command: ${args.join(' ')}`)
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
  return { root, config, calls, github, git, run, service: new WorkspaceRepositoryService(run) }
}
