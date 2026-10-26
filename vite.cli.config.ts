import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build, defineConfig } from 'vite'

const external = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)]

export default defineConfig({
  plugins: [{
    name: 'standalone-file-transfer-mcp',
    apply: 'build',
    async closeBundle() {
      await build({
        configFile: false,
        build: {
          target: 'node24', outDir: 'out/cli', emptyOutDir: false, minify: false,
          lib: {
            entry: fileURLToPath(new URL('./src/main/fileTransferMcp/entry.ts', import.meta.url)),
            formats: ['cjs'], fileName: () => 'taskcontinuum-files-mcp.cjs',
          },
          rollupOptions: { external },
        },
      })
    },
  }],
  build: {
    target: 'node24',
    outDir: 'out/cli',
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: fileURLToPath(new URL('./src/main/taskDocuments/entry.ts', import.meta.url)),
      formats: ['cjs'],
      fileName: () => 'task-documents.cjs',
    },
    rollupOptions: {
      external,
    },
  },
})
