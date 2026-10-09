export const repository: string
export const appId: string
export function validateVersion(tag: unknown, packageVersion: unknown, lockVersion: unknown, lockRootVersion: unknown): string
export function safeAssetName(name: unknown): string
export function readMetadata(text: string): Record<string, unknown>
export function signedPolicy(env: Record<string, string | undefined>, config: { forceCodeSigning?: boolean; win?: { signtoolOptions?: { publisherName?: string } } }): { schemaVersion: number; publisherNames: string[] } | null
export function validateUpdateConfig(config: Record<string, unknown>, publisher: string): void
export function artifactNames(version: string): { installer: string; zip: string }
export function validatePublishedVersions(tag: string, releases: { tag_name: string; draft: boolean; prerelease: boolean }[]): void
export function validateBundle(directory: string, version: string): Promise<{ version: string; assets: string[] }>
export function checksumsFor(directory: string, assets: string[]): Promise<string>
export function writeChecksums(directory: string, version: string): Promise<string[]>
export function validateChecksums(directory: string, version: string): Promise<string[]>
