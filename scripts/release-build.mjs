import { readFile } from 'node:fs/promises'
import { build, Platform, Arch } from 'electron-builder'
import { parse } from 'yaml'
import { signedPolicy } from './release-lib.mjs'

if (process.env.TASKCONTINUUM_SIGNED_RELEASE !== '1' || !process.env.CSC_LINK || !process.env.CSC_KEY_PASSWORD) {
  throw new Error('Signed release requires explicit opt-in and certificate secrets')
}
const config = parse(await readFile('electron-builder.yml', 'utf8'))
config.forceCodeSigning = true
config.win.signtoolOptions = { publisherName: process.env.TASKCONTINUUM_UPDATE_PUBLISHER }
signedPolicy(process.env, config)
await build({ targets: Platform.WINDOWS.createTarget(['nsis', 'zip'], Arch.x64), config, publish: 'never' })
