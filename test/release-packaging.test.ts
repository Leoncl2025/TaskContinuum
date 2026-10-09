// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import afterPack from '../build/after-pack.mjs'
import { signedPolicy, validateUpdateConfig } from '../scripts/release-lib.mjs'

const publisher = 'Test Certificate Common Name'
const config = { forceCodeSigning: true, win: { signtoolOptions: { publisherName: publisher } } }
afterEach(() => vi.unstubAllEnvs())

describe('intentional signed update capability', () => {
  it('keeps all normal unsigned builds manual-only', () => {
    expect(signedPolicy({}, {})).toBeNull()
    expect(signedPolicy({ TASKCONTINUUM_UPDATE_PUBLISHER: publisher }, config)).toBeNull()
    expect(signedPolicy({ TASKCONTINUUM_SIGNED_RELEASE: 'true' }, config)).toBeNull()
  })
  it('requires exact publisher and forceCodeSigning when explicitly requested', () => {
    const env = { TASKCONTINUUM_SIGNED_RELEASE: '1', TASKCONTINUUM_UPDATE_PUBLISHER: publisher }
    expect(signedPolicy(env, config)).toEqual({ schemaVersion: 1, publisherNames: [publisher] })
    expect(() => signedPolicy(env, {})).toThrow(/enforce/)
    expect(() => signedPolicy(env, { ...config, forceCodeSigning: false })).toThrow(/enforce/)
    expect(() => signedPolicy(env, { ...config, win: { signtoolOptions: { publisherName: 'Different' } } })).toThrow(/enforce/)
    for (const value of ['', ' Leading', 'Trailing ', 'Bad\nPublisher']) {
      expect(() => signedPolicy({ ...env, TASKCONTINUUM_UPDATE_PUBLISHER: value }, config)).toThrow(/common name/)
    }
  })
  it('requires the real signed publisher in fixed public GitHub builder metadata', () => {
    const updateConfig = { provider: 'github', owner: 'Leoncl2025', repo: 'TaskContinuum', releaseType: 'release', publisherName: [publisher] }
    expect(() => validateUpdateConfig(updateConfig, publisher)).not.toThrow()
    expect(() => validateUpdateConfig({ ...updateConfig, publisherName: publisher }, publisher)).not.toThrow()
    for (const change of [
      { publisherName: [] }, { publisherName: ['Different'] }, { publisherName: [publisher, 'Different'] },
      { provider: 'generic' }, { owner: 'other' }, { repo: 'other' }, { releaseType: 'prerelease' },
      { token: 'must-not-be-packaged' }, { host: 'other.example' }, { private: true },
    ]) expect(() => validateUpdateConfig({ ...updateConfig, ...change }, publisher)).toThrow(/fixed release policy/)
  })
  it('never puts an installation marker in the shared ZIP/NSIS payload and removes stale policies', async () => {
    await mkdir('artifacts', { recursive: true })
    const root = await mkdtemp(path.resolve('artifacts', 'release-packaging-'))
    const resources = path.join(root, 'resources')
    try {
      await mkdir(resources)
      await writeFile(path.join(root, 'taskcontinuum-install.json'), 'stale')
      vi.stubEnv('TASKCONTINUUM_SIGNED_RELEASE', '1')
      vi.stubEnv('TASKCONTINUUM_UPDATE_PUBLISHER', publisher)
      await afterPack({ appOutDir: root, packager: { config } })
      await expect(readFile(path.join(root, 'taskcontinuum-install.json'))).rejects.toThrow()
      expect(JSON.parse(await readFile(path.join(resources, 'update-policy.json'), 'utf8'))).toEqual({ schemaVersion: 1, publisherNames: [publisher] })
      vi.stubEnv('TASKCONTINUUM_SIGNED_RELEASE', '')
      await afterPack({ appOutDir: root, packager: { config: {} } })
      await expect(readFile(path.join(resources, 'update-policy.json'))).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('release configuration contracts', () => {
  it('preserves app identity, fixed public provider, marker lifecycle and local nonpublishing', async () => {
    const builder = parse(await readFile('electron-builder.yml', 'utf8'))
    expect(builder.appId).toBe('com.leoncl2025.taskcontinuum')
    expect(builder.publish).toMatchObject({ provider: 'github', owner: 'Leoncl2025', repo: 'TaskContinuum' })
    expect(builder.nsis.deleteAppDataOnUninstall).toBe(false)
    expect(builder.nsis.include).toBe('build/installer.nsh')
    const script = await readFile(builder.nsis.include, 'utf8')
    expect(script).toContain('!macro customInstall')
    expect(script).toContain('{"schemaVersion":1,"distribution":"nsis","appId":"com.leoncl2025.taskcontinuum"}')
    expect(script).toContain('Delete "$INSTDIR\\taskcontinuum-install.json"')
    const manifest = JSON.parse(await readFile('package.json', 'utf8'))
    expect(manifest.scripts['dist:win']).toContain('--publish never')
  })
  it('only dispatches trusted signed builds, drafts first and gates publication separately', async () => {
    const workflow = parse(await readFile('.github/workflows/release.yml', 'utf8'))
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.jobs.validate.if).toContain("github.event.repository.default_branch")
    expect(workflow.jobs.build.environment).toBe('release-signing')
    expect(workflow.jobs.publish.environment).toBe('production-release')
    expect(workflow.jobs.publish.needs).toContain('draft')
    for (const job of Object.values(workflow.jobs) as { steps: { run?: string }[] }[]) {
      for (const step of job.steps) expect(step.run ?? '').not.toContain('${{')
    }
  })
})
