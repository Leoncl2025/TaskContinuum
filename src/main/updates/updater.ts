import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { NsisUpdater } from 'electron-updater'
import { app } from 'electron'
import type { ReleaseCandidate } from './release'
import { stableVersion, validateReleaseCandidate } from './release'
import { verifyWindowsSignature } from './signature'
import type { SignatureVerifier } from './signature'
import { launchNsisInstaller } from './installerLaunch'

export interface UpdateInstaller {
  download(release: ReleaseCandidate, progress: (percent: number) => void): Promise<void>
  install(): Promise<void>
  onError?(listener: (error: Error) => void): () => void
  close(): void
}

export interface InstallerMetadata {
  version: string
  sha512: string
}

export function validateInstallerMetadata(input: unknown, selected: ReleaseCandidate): InstallerMetadata {
  validateReleaseCandidate(selected)
  if (!input || typeof input !== 'object') throw new Error('Missing update metadata.')
  const value = input as Record<string, unknown>
  if (stableVersion(value.version) !== selected.version || value.tag !== selected.tag) throw new Error('The release changed since it was selected. Check for updates again.')
  if (!Array.isArray(value.files) || value.files.length !== 1 || value.packages != null) {
    throw new Error('Expected a single full Windows installer in update metadata.')
  }
  const file = value.files[0] as Record<string, unknown> | null
  if (!file || file.url !== selected.installerName ||
      typeof file.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512) ||
      Buffer.from(file.sha512, 'base64').length !== 64) {
    throw new Error('Invalid installer URL or SHA-512 checksum.')
  }
  return { version: selected.version, sha512: file.sha512 }
}

async function verifyChecksum(path: string, expected: string): Promise<void> {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  if (hash.digest('base64') !== expected) throw new Error('Installer checksum validation failed.')
}

export function createElectronInstaller(publishers: readonly string[], verifySignature: SignatureVerifier = verifyWindowsSignature): UpdateInstaller {
  if (!publishers.length || publishers.some(name => !name.trim())) throw new Error('Signed updates require a nonempty publisher list.')
  const trustedPublishers = [...publishers]
  const updater = new NsisUpdater({
    provider: 'github', owner: 'Leoncl2025', repo: 'TaskContinuum', private: false,
  })
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.allowDowngrade = false
  updater.allowPrerelease = false
  updater.disableWebInstaller = true
  updater.disableDifferentialDownload = true
  updater.verifyUpdateCodeSignature = async (_names, path) => {
    await verifySignature(path, trustedPublishers)
    return null
  }
  let ready: { path: string; sha512: string } | undefined
  let closed = false
  let failure = 0
  let cancellation: { cancel(): void } | undefined
  const errors = new Set<(error: Error) => void>()
  const handleError = (error: Error) => {
    failure++
    ready = undefined
    for (const listener of errors) listener(error)
  }
  // electron-updater emits errors in addition to rejecting promises.
  updater.on('error', handleError)
  return {
    async download(selected, progress) {
      ready = undefined
      if (closed) throw new Error('Update service is closed.')
      const release = { ...selected }
      validateReleaseCandidate(release)
      if (!release.hasInstaller) throw new Error('The selected release has no full installer.')
      const initialFailure = failure
      const result = await updater.checkForUpdates()
      if (closed) throw new Error('Update service is closed.')
      if (!result?.isUpdateAvailable) throw new Error('The selected update is no longer available. Check again.')
      const metadata = validateInstallerMetadata(result.updateInfo, release)
      cancellation = result.cancellationToken
      const onProgress = (value: { percent: number }) => progress(value.percent)
      const validatePinnedMetadata = (info: unknown) => {
        if (validateInstallerMetadata(info, release).sha512 !== metadata.sha512) {
          throw new Error('Installer metadata changed during download. Check for updates again.')
        }
      }
      let metadataError: unknown
      const onDownloaded = (info: unknown) => {
        try { validatePinnedMetadata(info) } catch (error) { metadataError = error }
      }
      updater.on('download-progress', onProgress)
      updater.on('update-downloaded', onDownloaded)
      try {
        const paths = await updater.downloadUpdate(result.cancellationToken)
        if (metadataError) throw metadataError
        validatePinnedMetadata(result.updateInfo)
        if (paths.length !== 1) throw new Error('Expected exactly one downloaded installer.')
        // Cached installers bypass the upstream signature hook, so verify every
        // returned file ourselves before exposing an installable update.
        await verifyChecksum(paths[0], metadata.sha512)
        await verifySignature(paths[0], trustedPublishers)
        if (metadataError) throw metadataError
        validatePinnedMetadata(result.updateInfo)
        if (closed) throw new Error('Update service is closed.')
        if (failure !== initialFailure) throw new Error('Installer reported an error during download.')
        ready = { path: paths[0], sha512: metadata.sha512 }
      } finally {
        cancellation = undefined
        updater.removeListener('download-progress', onProgress)
        updater.removeListener('update-downloaded', onDownloaded)
      }
    },
    async install() {
      const selected = ready
      ready = undefined
      if (closed || !selected) throw new Error('No verified installer is ready.')
      const initialFailure = failure
      await verifyChecksum(selected.path, selected.sha512)
      await verifySignature(selected.path, trustedPublishers)
      if (closed) throw new Error('Update service is closed.')
      if (failure !== initialFailure) throw new Error('Installer reported an error before launch.')
      // Upstream quitAndInstall schedules quit before its asynchronous spawn can
      // fail. Wait for a real launch so failed launches reach restart recovery.
      await launchNsisInstaller(selected.path)
      app.quit()
    },
    onError(listener) {
      errors.add(listener)
      return () => errors.delete(listener)
    },
    close() {
      closed = true
      ready = undefined
      cancellation?.cancel()
      cancellation = undefined
      errors.clear()
      // Keep the error handler until the updater has stopped in-flight work.
      // With autoInstallOnAppQuit=false a completed download can never install itself.
    },
  }
}
