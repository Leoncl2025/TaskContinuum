import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { UpdateDistribution } from '../../shared/updates'
import { verifyWindowsSignature } from './signature'
import type { SignatureVerifier } from './signature'

export interface DistributionOptions {
  isPackaged: boolean
  platform: string
  arch: string
  execPath: string
  resourcesPath: string
  readText?: (path: string) => Promise<string>
  verifySignature?: SignatureVerifier
}

export interface DistributionCapability {
  distribution: UpdateDistribution
  canInstall: boolean
  reason?: string
  publisherNames: string[]
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export async function detectDistribution(options: DistributionOptions): Promise<DistributionCapability> {
  const readText = options.readText ?? (path => readFile(path, 'utf8'))
  const result = (distribution: UpdateDistribution, reason: string): DistributionCapability => ({ distribution, canInstall: false, reason, publisherNames: [] })
  if (!options.isPackaged) return result('development', 'Automatic installation is disabled in development.')
  if (options.platform !== 'win32' || options.arch !== 'x64') return result('unsupported', 'Automatic installation requires Windows x64.')
  let marker: unknown
  try {
    marker = JSON.parse(await readText(join(dirname(options.execPath), 'taskcontinuum-install.json')))
  } catch (error) {
    return result('archive', missing(error) ? 'Archive installations must be updated manually.' : 'Invalid installation marker. Use a trusted installer to enable updates.')
  }
  if (!marker || typeof marker !== 'object' || !('schemaVersion' in marker) || marker.schemaVersion !== 1 ||
      !('distribution' in marker) || marker.distribution !== 'nsis' || !('appId' in marker) || marker.appId !== 'com.leoncl2025.taskcontinuum') {
    return result('archive', 'Invalid installation marker. Use a trusted installer to enable updates.')
  }
  let policy: unknown
  try {
    policy = JSON.parse(await readText(join(options.resourcesPath, 'update-policy.json')))
  } catch (error) {
    return result('nsis', missing(error) ? 'This installation has no signed update policy. Update manually.' : 'Invalid signed update policy. Update manually.')
  }
  if (!policy || typeof policy !== 'object' || !('schemaVersion' in policy) || policy.schemaVersion !== 1 ||
      !('publisherNames' in policy) || !Array.isArray(policy.publisherNames) || !policy.publisherNames.length ||
      policy.publisherNames.some(name => typeof name !== 'string' || !name.trim() || name !== name.trim())) {
    return result('nsis', 'Invalid signed update policy: a nonempty publisher list is required.')
  }
  const publisherNames = policy.publisherNames as string[]
  try {
    await (options.verifySignature ?? verifyWindowsSignature)(options.execPath, publisherNames)
  } catch (error) {
    return result('nsis', `Installed application signature could not be verified: ${error instanceof Error ? error.message : 'verification failed'}`)
  }
  return { distribution: 'nsis', canInstall: true, publisherNames: [...publisherNames] }
}
