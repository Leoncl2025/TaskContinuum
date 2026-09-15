// @vitest-environment node
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('registers native AHP without the retired SDK, shared-host or Companion runtimes', async () => {
  const main = await readFile(resolve('src/main/index.ts'), 'utf8')
  expect(main).toContain('registerAgentHostBridge')
  expect(main).toContain('registerRemoteVSCodeBridge')
  expect(main).not.toMatch(/register(?:Copilot|Shared|VSCodeChat)Bridge/)
  const build = await readFile(resolve('electron.vite.config.ts'), 'utf8')
  expect(build).not.toContain('shared/daemon')
  expect(build).not.toContain('shared-host')
})

it('does not ship the retired SDK dependency or extension packaging entry', async () => {
  const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
  expect(manifest.dependencies).not.toHaveProperty('@github/copilot-sdk')
  expect(manifest.devDependencies).not.toHaveProperty('@vscode/vsce')
  expect(manifest.devDependencies).not.toHaveProperty('@types/vscode')
  expect(manifest.scripts).not.toHaveProperty('build:vscode-bridge')
  await expect(access(resolve('scripts/build-vscode-bridge.mjs'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(access(resolve('vscode-bridge/package.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
