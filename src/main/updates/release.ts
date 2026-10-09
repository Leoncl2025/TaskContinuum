import semver from 'semver'
import type { UpdateRelease } from '../../shared/updates'

export const RELEASE_REPOSITORY = 'Leoncl2025/TaskContinuum'
export const RELEASES_URL = `https://github.com/${RELEASE_REPOSITORY}/releases`
export const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`

export interface ReleaseCandidate extends UpdateRelease {
  tag: string
  installerName: string
  hasInstaller: boolean
}

export function stableVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) || semver.valid(value) !== value) {
    throw new Error('Only strict stable semantic versions are supported.')
  }
  return value
}

export function isNewer(version: string, current: string): boolean {
  return semver.gt(stableVersion(version), stableVersion(current))
}

export function releaseUrl(tag: string): string {
  stableVersion(tag.startsWith('v') ? tag.slice(1) : tag)
  return `${RELEASES_URL}/tag/${tag}`
}

export function validateReleaseCandidate(release: ReleaseCandidate): void {
  const version = stableVersion(release.version)
  if (release.url !== releaseUrl(release.tag) || release.tag.replace(/^v/, '') !== version ||
      release.installerName !== `TaskContinuum-${version}-win-x64-setup.exe`) {
    throw new Error('Invalid selected release URL, version, or installer.')
  }
}

export function parseRelease(input: unknown): ReleaseCandidate {
  if (!input || typeof input !== 'object') throw new Error('Invalid GitHub release response.')
  const value = input as Record<string, unknown>
  if (value.draft !== false || value.prerelease !== false || typeof value.tag_name !== 'string') {
    throw new Error('The release is not a published stable release.')
  }
  const tag = value.tag_name
  const version = stableVersion(tag.startsWith('v') ? tag.slice(1) : tag)
  const url = releaseUrl(tag)
  if (value.html_url !== url || !Array.isArray(value.assets)) throw new Error('Invalid release URL or assets.')
  const installerName = `TaskContinuum-${version}-win-x64-setup.exe`
  const names = new Set<string>()
  for (const asset of value.assets) {
    if (!asset || typeof asset !== 'object' || typeof asset.name !== 'string' || names.has(asset.name) ||
        asset.browser_download_url !== `https://github.com/${RELEASE_REPOSITORY}/releases/download/${tag}/${asset.name}` ||
        !/^[A-Za-z0-9._-]+$/.test(asset.name) || typeof asset.size !== 'number' || asset.size <= 0) {
      throw new Error('Invalid release assets.')
    }
    names.add(asset.name)
  }
  if (value.body != null && typeof value.body !== 'string') throw new Error('Invalid release notes.')
  if (value.name != null && typeof value.name !== 'string') throw new Error('Invalid release name.')
  return {
    version, tag, url, installerName,
    name: typeof value.name === 'string' ? value.name.slice(0, 500) : tag,
    notes: typeof value.body === 'string' ? value.body.slice(0, 100_000) : '',
    hasInstaller: names.has(installerName) && names.has('latest.yml'),
  }
}

export async function fetchLatestRelease(signal?: AbortSignal): Promise<ReleaseCandidate> {
  const response = await fetch(LATEST_RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`Release check failed (HTTP ${response.status}). Please try again later.`)
  const text = await response.text()
  if (text.length > 2_000_000) throw new Error('Release response is too large.')
  return parseRelease(JSON.parse(text))
}
