import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { signedPolicy } from '../scripts/release-lib.mjs'

export default async function afterPack(context) {
  const resources = path.join(context.appOutDir, 'resources')
  const policyPath = path.join(resources, 'update-policy.json')
  // NSIS and ZIP share appOutDir. Only the installer may create this marker.
  await rm(path.join(context.appOutDir, 'taskcontinuum-install.json'), { force: true })
  await rm(policyPath, { force: true })
  const policy = signedPolicy(process.env, context.packager.config)
  if (policy) {
    await mkdir(resources, { recursive: true })
    await writeFile(policyPath, `${JSON.stringify(policy)}\n`, { flag: 'wx' })
  }
}
