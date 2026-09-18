import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
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
      external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    },
  },
})
