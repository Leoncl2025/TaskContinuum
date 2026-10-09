import { spawn } from 'node:child_process'

export function launchNsisInstaller(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, ['--updated', '--force-run'], {
      detached: true, stdio: 'ignore', windowsHide: true,
    })
    const failed = (error: Error) => { child.removeListener('spawn', started); reject(error) }
    const started = () => {
      child.removeListener('error', failed)
      child.unref()
      resolve()
    }
    child.once('error', failed)
    child.once('spawn', started)
  })
}
