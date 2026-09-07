import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { createVSIX } from '@vscode/vsce'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(root, 'vscode-bridge/package.json'), 'utf8'))
if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid companion version.')
const packageName = `taskcontinuum-vscode-bridge-${manifest.version}.vsix`
await build({
  configFile: false,
  root,
  build: {
    ssr: true,
    outDir: resolve(root, 'vscode-bridge/out'),
    emptyOutDir: true,
    lib: { entry: resolve(root, 'src/main/vscodeChatExtension.ts'), formats: ['cjs'], fileName: () => 'extension.cjs' },
    rollupOptions: { external: ['vscode'], output: { entryFileNames: 'extension.cjs', format: 'cjs' } },
    minify: false,
  },
  ssr: { noExternal: ['zod'] },
})
await copyFile(resolve(root, 'vscode-bridge/delivery.agent.md'), resolve(root, 'vscode-bridge/out/delivery.agent.md'))
await mkdir(resolve(root, 'artifacts'), { recursive: true })
process.chdir(resolve(root, 'vscode-bridge'))
await createVSIX({
  cwd: resolve(root, 'vscode-bridge'),
  packagePath: resolve(root, 'artifacts', packageName),
  dependencies: false,
  allowMissingRepository: true,
  skipLicense: true,
})
console.log(`Built artifacts/${packageName}`)