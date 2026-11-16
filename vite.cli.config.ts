import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build, defineConfig } from 'vite'

const external = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)]

export default defineConfig({
  plugins: [{
    name: 'standalone-mcp-entries',
    apply: 'build',
    async closeBundle() {
      for (const [entry, output] of [
        ['./src/main/fileTransferMcp/entry.ts', 'taskcontinuum-files-mcp.cjs'],
        ['./src/main/sessionCollaborationMcp/entry.ts', 'taskcontinuum-collab-mcp.cjs'],
      ] as const) {
        await build({
          configFile: false,
          build: {
            target: 'node24', outDir: 'out/cli', emptyOutDir: false, minify: false,
            lib: {
              entry: fileURLToPath(new URL(entry, import.meta.url)),
              formats: ['cjs'], fileName: () => output,
            },
            rollupOptions: { external },
          },
        })
      }
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
