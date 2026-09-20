import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { GitReplica } from './git'
import type { GitPublication, GitReplicaOptions, GitSyncOptions, GitSyncResult } from './git'

const execute = promisify(execFile)
export type WorkspaceGitOptions = GitReplicaOptions

/** Bootstrap validates fetched configuration before allowing its first publication. */
export class WorkspaceGitReplica {
  private constructor(private readonly inner: GitReplica) {}

  get root(): string { return this.inner.root }
  get workspaceRelativePath(): string { return this.inner.workspaceRelativePath }
  get remote(): string { return this.inner.remote }
  get branch(): string { return this.inner.branch }
  get upstreamUrl(): string { return this.inner.upstreamUrl }

  static async open(options: WorkspaceGitOptions): Promise<WorkspaceGitReplica> {
    const inner = await GitReplica.open({ ...options, prepare: false })
    const replica = new WorkspaceGitReplica(inner)
    try {
      if (options.prepare !== false) {
        await inner.sync([], {
          validateReplica: async (checkout) => {
            const heads = (await replica.local(['rev-parse', 'HEAD', 'FETCH_HEAD'], checkout)).split(/\r?\n/)
            if (heads.length !== 2 || heads[0] !== heads[1]) throw new Error('Bootstrap found pending publication commits. Restore the existing enrollment before publishing them.')
          },
        })
      }
      return replica
    } catch (error) { await inner.close(); throw error }
  }

  private async local(args: string[], cwd: string): Promise<string> {
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|NAMESPACE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*|PREFIX)$/i.test(key)) delete env[key]
    const result = await execute('git', [
      '--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false',
      ...args,
    ], { cwd, windowsHide: true, timeout: 10000, maxBuffer: 32768, env: { ...env, GIT_TERMINAL_PROMPT: '0' } })
    return result.stdout.trim()
  }

  async assertUpstream(): Promise<void> {
    await this.inner.assertUpstream()
  }

  async sync(files: readonly GitPublication[] = [], options: GitSyncOptions = {}): Promise<GitSyncResult> {
    return this.inner.sync(files, options)
  }

  async close(): Promise<void> {
    await this.inner.close()
  }
}
