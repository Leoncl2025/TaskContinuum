import { detectDistribution } from './distribution'
import { fileUpdatePreferences } from './preferences'
import { UpdateService } from './service'

export { UpdateService } from './service'
export type { UpdateServiceOptions, UpdateClock } from './service'
export { detectDistribution } from './distribution'

export interface DesktopUpdateOptions {
  currentVersion: string
  isPackaged: boolean
  userData: string
  resourcesPath: string
  execPath?: string
  platform?: string
  arch?: string
  openExternal: (url: string) => Promise<unknown>
  install: (installer: () => Promise<void>) => Promise<void>
}

export async function createDesktopUpdateService(options: DesktopUpdateOptions): Promise<UpdateService> {
  const capability = await detectDistribution({
    isPackaged: options.isPackaged, platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch, execPath: options.execPath ?? process.execPath,
    resourcesPath: options.resourcesPath,
  })
  const installer = capability.canInstall
    ? (await import('./updater')).createElectronInstaller(capability.publisherNames)
    : undefined
  return UpdateService.create({
    currentVersion: options.currentVersion, capability, installer,
    preferences: fileUpdatePreferences(options.userData),
    openExternal: options.openExternal, prepareInstall: options.install,
  })
}
