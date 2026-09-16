// @vitest-environment node
import { ChildProcess, execFile } from 'node:child_process'
import type { ExecFileException } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { executeRepositoryCommand } from '../src/main/workspaceRepository'

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: vi.fn(),
}))

const options = { cwd: process.cwd(), env: {}, timeout: 1000 }

function result(error: ExecFileException | null, stdout = '', stderr = ''): void {
  vi.mocked(execFile).mockImplementation((_program, _args, _options, callback) => {
    callback?.(error, stdout, stderr)
    return new ChildProcess()
  })
}

describe('repository command exit codes', () => {
  it('returns numeric zero and trimmed output only for a successful command', async () => {
    result(null, '  git version\n')
    await expect(executeRepositoryCommand('git', ['--version'], options)).resolves.toEqual({
      code: 0, stdout: 'git version', stderr: '',
    })
  })

  it.each([1, 128])('preserves numeric failure exit code %s', async (code) => {
    result(Object.assign(new Error('Command failed.'), { code }), '', '  Git failed.\n')
    await expect(executeRepositoryCommand('git', ['status'], options)).resolves.toEqual({
      code, stdout: '', stderr: 'Git failed.',
    })
  })

  it('rejects missing executables with an actionable installation error', async () => {
    result(Object.assign(new Error('Command not found.'), { code: 'ENOENT' }))
    await expect(executeRepositoryCommand('gh', ['--version'], options)).rejects.toMatchObject({
      code: 'ENOENT', message: 'Install GitHub CLI (gh) and restart Task Continuum.',
    })
  })

  it.each(['EACCES', undefined])('rejects non-exit-code failures (%s) instead of treating them as success', async (code) => {
    result(Object.assign(new Error('Execution failed.'), { code }))
    await expect(executeRepositoryCommand('git', ['status'], options)).rejects.toThrow('did not finish')
  })
})
