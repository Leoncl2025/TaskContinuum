import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { readMetadata, validateUpdateConfig } from './release-lib.mjs'

const resources = process.env.TASKCONTINUUM_VERIFY_RESOURCES
const publisher = process.env.TASKCONTINUUM_UPDATE_PUBLISHER
if (!resources || !publisher) throw new Error('Resources directory and expected publisher are required')
const config = readMetadata(await readFile(path.join(resources, 'app-update.yml'), 'utf8'))
validateUpdateConfig(config, publisher)
