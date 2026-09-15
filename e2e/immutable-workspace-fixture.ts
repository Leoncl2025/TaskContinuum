import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { appendRecord, createRecord } from '../src/main/remoteConfig/records'
import type { RecordTrust } from '../src/main/remoteConfig/records'
import { writeJsonAtomic } from '../src/main/shared/storage'
import type { SessionLinksSnapshot } from '../src/shared/sessionBindings'
import { immutableRecordSigner } from '../test/immutable-bindings-fixture'

const execute = promisify(execFile)

export async function prepareAutomaticLinksRepository(workspace: string, fixtureDirectory: string) {
  const home = join(fixtureDirectory, 'home')
  const environment = {
    HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  }
  await Promise.all([fixtureDirectory, environment.APPDATA, environment.LOCALAPPDATA].map((directory) => mkdir(directory, { recursive: true })))
  const git = async (cwd: string, ...args: string[]) => {
    await execute('git', ['--no-pager', '-c', 'core.autocrlf=false', '-c', 'core.longpaths=true', '-c', 'commit.gpgSign=false', ...args], {
      cwd, windowsHide: true, timeout: 30000, env: { ...process.env, ...environment },
    })
  }
  const remote = join(fixtureDirectory, 'upstream.git')
  const workspaceId = randomUUID()
  const client = immutableRecordSigner(101)
  const host = immutableRecordSigner(102)
  const { actor, sign } = client
  const deviceId = actor.deviceId
  const trust: RecordTrust = { workspaceId, trustedKey: new Map([[deviceId, client.publicKey]]), authorize: (record) => record.actor.deviceId === deviceId }
  const device = await createRecord({
    kind: 'device', workspaceId, actor,
    payload: {
      action: 'publish', deviceId,
      identity: {
        username: 'fixture', machineName: 'offline-enrollment-fixture',
        clientPublicKey: client.publicKey, hostPublicKey: host.publicKey,
        clientKeyId: actor.keyId, hostKeyId: host.actor.keyId,
      },
      routes: [{ kind: 'dev-tunnel', tunnelId: 'offline-fixture.test', sshPort: 2222, controlPort: 2223 }],
    },
  }, sign)
  // The signed workspace setting prevents account sign-in and remote publication.
  // Local Agent Host access and the real Git/enrollment/binding backend remain intact.
  const offline = await createRecord({
    kind: 'setting', workspaceId, actor,
    payload: { action: 'set', scope: 'workspace', settingKey: 'tunnelEnabled', value: false },
  }, sign)
  await appendRecord(workspace, device, trust)
  await appendRecord(workspace, offline, trust)
  await writeJsonAtomic(join(workspace, '.taskcontinuum', 'workspace.json'), {
    schemaVersion: 1, kind: 'taskcontinuum-workspace', workspaceId, remoteConfigFormat: 'immutable-operations-v1',
  }, true)
  await git(fixtureDirectory, 'init', '--bare', '--initial-branch=main', remote)
  await git(workspace, 'init', '--initial-branch=main')
  await git(workspace, 'config', 'user.name', 'Task Continuum E2E')
  await git(workspace, 'config', 'user.email', 'e2e@example.invalid')
  await git(workspace, 'add', '--', '.agentdesk', 'tasks', '.taskcontinuum/records', '.taskcontinuum/workspace.json')
  await git(workspace, 'commit', '-m', 'Initialize isolated immutable workspace fixture')
  await git(workspace, 'remote', 'add', 'origin', remote)
  await git(workspace, 'push', '--set-upstream', 'origin', 'main')
  return { workspaceId, environment }
}

export async function readDesktopBindings(page: Page): Promise<SessionLinksSnapshot> {
  return page.evaluate(async () => {
    const workspace = (await window.workspace!.getState()).current
    if (!workspace) throw new Error('Open the fixture workspace before reading its bindings.')
    return window.workspace!.getSessionLinks(workspace.id)
  })
}

export async function enableAutomaticLinks(app: ElectronApplication, page: Page, profile: string): Promise<SessionLinksSnapshot> {
  const consent = await app.evaluateHandle(({ dialog, safeStorage }) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('The immutable desktop fixture requires OS-protected key storage.')
    const original = dialog.showMessageBox
    const prompts: string[] = []
    dialog.showMessageBox = async (...args: unknown[]) => {
      const options = args.at(-1) as { message: string; detail?: string }
      if (options.message !== 'Synchronize this workspace and automatically link its enrolled devices?') throw new Error(`Unexpected enrollment consent: ${options.message}`)
      prompts.push(options.detail ?? '')
      return { response: 1, checkboxChecked: false }
    }
    return { prompts, restore: () => { dialog.showMessageBox = original } }
  })
  try {
    expect(await page.evaluate(() => window.remoteVSCode!.gitSync!.enable())).toBe(true)
    const prompts = await consent.evaluate((probe) => probe.prompts)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Legacy session files and browser bindings are not imported')
  } finally {
    await consent.evaluate((probe) => probe.restore())
    await consent.dispose()
  }
  const snapshot = await readDesktopBindings(page)
  expect(snapshot.document.bindings).toEqual({})
  expect(snapshot.revision).toMatch(/^[a-f0-9]{64}$/)
  expect(snapshot.localOwner).toMatchObject({ clientId: expect.any(String), machineName: expect.any(String) })
  const status = await page.evaluate(() => window.remoteVSCode!.gitSync!.status())
  expect(status).toMatchObject({ enabled: true, settings: { tunnelEnabled: false } })
  expect(status.error).toBeUndefined()
  for (const purpose of ['client', 'host']) {
    const key = JSON.parse(await readFile(join(profile, `dev-tunnel-${purpose}-identity.json`), 'utf8')) as { encryptedPrivateKey: string }
    expect(key.encryptedPrivateKey).toBeTruthy()
    expect(Buffer.from(key.encryptedPrivateKey, 'base64').toString()).not.toContain('PRIVATE KEY')
  }
  return snapshot
}
