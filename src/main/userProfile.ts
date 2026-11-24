import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readClientIdentity } from './clientIdentity'
import type { DesktopUserProfile } from '../shared/desktop'

const execFileAsync = promisify(execFile)
export const MAX_USER_DISPLAY_NAME_LENGTH = 80

let cachedGlobalGitName: Promise<string | undefined> | undefined

function sanitizeDisplayName(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? ''
  if (!firstLine) return undefined
  for (let index = 0; index < firstLine.length; index++) {
    const code = firstLine.charCodeAt(index)
    if (code < 32 || code === 127) return undefined
  }
  return firstLine.slice(0, MAX_USER_DISPLAY_NAME_LENGTH)
}

async function queryGitUserName(args: readonly string[], cwd?: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      ...(cwd ? { cwd } : {}),
      timeout: 1500,
      windowsHide: true,
      maxBuffer: 4096,
    })
    return sanitizeDisplayName(stdout)
  } catch {
    return undefined
  }
}

function globalGitUserName(): Promise<string | undefined> {
  cachedGlobalGitName ??= queryGitUserName(['config', '--global', 'user.name'])
  return cachedGlobalGitName
}

export async function resolveLocalUserProfile(userDataDir: string, workspaceRoot?: string): Promise<DesktopUserProfile> {
  const identity = await readClientIdentity(userDataDir)
  const repoName = workspaceRoot ? await queryGitUserName(['config', 'user.name'], workspaceRoot) : undefined
  const gitName = repoName ?? await globalGitUserName()
  return {
    clientId: identity.clientId,
    loginUsername: identity.username,
    displayName: gitName || identity.username,
  }
}
